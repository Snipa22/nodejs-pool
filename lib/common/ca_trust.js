"use strict";

const tls = require("node:tls");
const { X509Certificate } = require("node:crypto");

// emSign ECC Root CA - G3 signed the intermediates compromised in October 2026.
const BLOCKED_ROOT_SHA256 = "86:A1:EC:BA:08:9C:4A:8D:3B:BE:27:34:C6:12:BA:34:1D:81:3E:04:3C:F9:E8:A8:62:CD:5C:57:A3:6B:BE:6B";

/** @returns {boolean} */
function usesOpenSslCa() {
    // Command-line CA selection overrides NODE_OPTIONS. These flags have no values.
    const selectCaFlags = (/** @type {string[]} */ args) => args.map((arg) => arg.replace(/_/g, "-"))
        .filter((arg) => arg === "--use-openssl-ca" || arg === "--use-bundled-ca");
    const commandLine = selectCaFlags(process.execArgv);
    if (commandLine.length) return commandLine.at(-1) === "--use-openssl-ca";
    // Keep quoted option values together so a preload filename containing a CA
    // flag is not mistaken for CA selection. Node validates malformed quoting.
    const tokens = (process.env["NODE_OPTIONS"] || "").match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) || [];
    const environment = selectCaFlags(tokens.map((token) => token.replace(/"((?:[^"\\]|\\.)*)"/g, "$1")));
    return environment.at(-1) === "--use-openssl-ca";
}

/** @param {string} certificate @returns {boolean} */
function isBlockedRoot(certificate) {
    return new X509Certificate(certificate).fingerprint256 === BLOCKED_ROOT_SHA256;
}

/**
 * Remove the compromised root from the effective default CA store before loading
 * application dependencies or making TLS connections. Each cluster process must
 * call this itself; Node's default CA setter affects only the current thread.
 * Explicit per-connection CA certificates and pinned pool certificates are untouched.
 * @returns {number} Number of blocked certificate entries removed.
 */
function applyCaTrustPolicy() {
    const openSslCa = usesOpenSslCa();
    if (typeof tls.getCACertificates !== "function") {
        // Older supported Node versions cannot enumerate OpenSSL's trust store.
        // Its clean CA file/directory remain the operator's responsibility.
        if (openSslCa) return 0;
        if (!tls.rootCertificates.some(isBlockedRoot)) return 0;
        throw new Error("The bundled TLS CA store includes a blocked root. Upgrade to Node.js 22.19+ or 24.5+, or start with --use-openssl-ca and a cleaned OpenSSL CA store.");
    }

    const certificates = tls.getCACertificates("default");
    const trusted = certificates.filter((certificate) => !isBlockedRoot(certificate));
    const removed = certificates.length - trusted.length;
    if (!removed) return 0;

    // OpenSSL roots are not enumerable here. A nonempty list can contain extra
    // certificates only; replacing it would silently discard the system roots.
    if (openSslCa) {
        throw new Error("The OpenSSL TLS configuration includes a blocked extra CA. Remove it from NODE_EXTRA_CA_CERTS or the configured CA store before starting.");
    }
    if (typeof tls.setDefaultCACertificates !== "function") {
        throw new Error("The default TLS CA store includes a blocked root. Upgrade to Node.js 22.19+ or 24.5+, or start with --use-openssl-ca and a cleaned OpenSSL CA store.");
    }
    tls.setDefaultCACertificates(trusted);
    return removed;
}

module.exports = applyCaTrustPolicy;
