"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const tls = require("node:tls");
const { X509Certificate } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const modulePath = path.resolve(__dirname, "../lib/common/ca_trust.js");
const source = fs.readFileSync(modulePath, "utf8");
const blockedFingerprint = "86:A1:EC:BA:08:9C:4A:8D:3B:BE:27:34:C6:12:BA:34:1D:81:3E:04:3C:F9:E8:A8:62:CD:5C:57:A3:6B:BE:6B";
// Public CA certificate, retained so the tests still exercise removal after Node
// releases stop bundling this root. There is no private key in this fixture.
const blockedCertificate = `-----BEGIN CERTIFICATE-----
MIICTjCCAdOgAwIBAgIKPPYHqWhwDtqLhDAKBggqhkjOPQQDAzBrMQswCQYDVQQGEwJJTjET
MBEGA1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGlt
aXRlZDEgMB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0gRzMwHhcNMTgwMjE4MTgzMDAw
WhcNNDMwMjE4MTgzMDAwWjBrMQswCQYDVQQGEwJJTjETMBEGA1UECxMKZW1TaWduIFBLSTEl
MCMGA1UEChMcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEgMB4GA1UEAxMXZW1TaWdu
IEVDQyBSb290IENBIC0gRzMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQjpQy4LRL1KPOxst3i
AhKAnjlfSU2fySU0WXTsuwYc58Byr+iuL+FBVIcUqEqy6HyC5ltqtdyzdc6LBtCGI79G1Y4P
PwT01xySfvalY8L1X44uT6EYGQIrMgqCZH0Wk9GjQjBAMB0GA1UdDgQWBBR8XQKEE9TMipuB
zhccLikenEhjQjAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AwNpADBmAjEAvvNhzwIQHWSVB7gYboiFBS+DCBeQyh+KTOgNG3qxrdWBCUfvO6wIBHxcmbHt
RwfSAjEAnbpV/KlK6O3t5nYBQnvI+GDZjVGLVTv7jHvrZQnD+JbNR6iC8hZVdyR+EhCVBCyj
-----END CERTIFICATE-----`;
const otherCertificate = tls.rootCertificates.find((certificate) => new X509Certificate(certificate).fingerprint256 !== blockedFingerprint);

function child(script, flags = ["--use-bundled-ca"]) {
    const env = { ...process.env };
    for (const key of ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"]) delete env[key];
    const result = spawnSync(process.execPath, [...flags, "-e", `
        const assert = require("node:assert/strict");
        const tls = require("node:tls");
        const { X509Certificate } = require("node:crypto");
        const apply = require(${JSON.stringify(modulePath)});
        const blocked = ${JSON.stringify(blockedCertificate)};
        const fingerprint = ${JSON.stringify(blockedFingerprint)};
        const fingerprints = (certs) => [...new Set(certs.map((cert) => new X509Certificate(cert).fingerprint256))].sort();
        ${script}
    `], { encoding: "utf8", env, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function isolated(tlsApi, { execArgv = [], env = {} } = {}) {
    const context = {
        require(name) {
            if (name === "node:tls") return tlsApi;
            if (name === "node:crypto") return { X509Certificate };
            throw new Error(`Unexpected require: ${name}`);
        },
        process: { execArgv, env },
        module: { exports: {} }
    };
    vm.runInNewContext(source, context, { filename: modulePath });
    return context.module.exports;
}

test.describe("default TLS CA trust policy", () => {
    test("filters the compromised root from real effective trust and is idempotent", () => {
        child(`
            tls.setDefaultCACertificates([...tls.getCACertificates("default"), blocked]);
            const before = fingerprints(tls.getCACertificates("default"));
            assert(before.includes(fingerprint));
            assert.equal(apply(), 1);
            assert.deepEqual(fingerprints(tls.getCACertificates("default")), before.filter((value) => value !== fingerprint));
            assert.equal(apply(), 0);
            // A caller's explicit CA/pinning remains independent of defaults.
            assert.doesNotThrow(() => tls.createSecureContext({ ca: blocked }));
        `);
    });

    test("preserves a preconfigured custom default CA set", () => {
        child(`
            const other = tls.rootCertificates.find((cert) => new X509Certificate(cert).fingerprint256 !== fingerprint);
            tls.setDefaultCACertificates([other, blocked]);
            assert.equal(apply(), 1);
            assert.deepEqual(fingerprints(tls.getCACertificates("default")), fingerprints([other]));
        `);
    });

    test("does not replace the unenumerated OpenSSL trust store with an empty list", () => {
        child(`
            assert.equal(tls.getCACertificates("default").length, 0);
            tls.setDefaultCACertificates = () => { throw new Error("Must not replace OpenSSL trust"); };
            assert.equal(apply(), 0);
            assert.doesNotThrow(() => tls.createSecureContext());
        `, ["--use-openssl-ca"]);
    });

    test("does not mistake OpenSSL extra roots for the complete system store", () => {
        let changed = false;
        const apply = isolated({
            getCACertificates: () => [otherCertificate, blockedCertificate],
            setDefaultCACertificates: () => { changed = true; }
        }, { execArgv: ["--use-openssl-ca"] });
        assert.throws(apply, /blocked extra CA/);
        assert.equal(changed, false);
    });

    test("older Node versions fail closed with actionable CA configuration guidance", () => {
        const apply = isolated({ rootCertificates: [otherCertificate, blockedCertificate] });
        assert.throws(apply, /Upgrade to Node\.js 22\.19\+ or 24\.5\+.*--use-openssl-ca/);
        const noSetter = isolated({ getCACertificates: () => [blockedCertificate] });
        assert.throws(noSetter, /default TLS CA store includes a blocked root/);
    });

    test("older Node versions can keep explicitly selected clean OpenSSL trust", () => {
        const api = { rootCertificates: [blockedCertificate] };
        assert.equal(isolated(api, { execArgv: ["--use-openssl-ca"] })(), 0);
        assert.equal(isolated(api, { env: { NODE_OPTIONS: '"--use-openssl-ca"' } })(), 0);
        assert.throws(isolated(api, {
            execArgv: ["--use-bundled-ca"],
            env: { NODE_OPTIONS: "--use-openssl-ca" }
        }), /bundled TLS CA store includes a blocked root/);
    });

    test("an already clean legacy bundled store is unchanged", () => {
        assert.equal(isolated({ rootCertificates: [otherCertificate] })(), 0);
    });

    test("CA-looking preload names do not bypass legacy bundled-root checks", () => {
        const api = { rootCertificates: [blockedCertificate] };
        for (const option of ['--require="some --use-openssl-ca"', '--require=some--use-openssl-ca']) {
            assert.throws(isolated(api, { env: { NODE_OPTIONS: option } }), /bundled TLS CA store includes a blocked root/);
        }
        assert.equal(isolated(api, { env: { NODE_OPTIONS: "--use_openssl_ca" } })(), 0);
    });
});
