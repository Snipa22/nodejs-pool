"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const zlib = require("node:zlib");
const blockTemplate = require("node-blocktemplate");

const pearl = require("../../../lib/coins/core/pearl.js");
const pearlProfile = require("../../../lib/coins/pearl.js");

function validPearlVerifierConfig(adjustment_factor) {
    return {
        m: 1, n: 1, k: 128, rank: 128, experts: 0, top_k: 0,
        expert_index: 0, t_rows: 1, t_cols: 1, adjustment_factor, moe: false
    };
}

const PEARL_SOLUTION_DATA = Buffer.from([1, ...Buffer.alloc(32, 0x56)]);
const PEARL_SOLUTION_ID = blockTemplate.pearlSolutionId(PEARL_SOLUTION_DATA).toString("hex");

function pearlSolutionIdFromData(solutionData) {
    return blockTemplate.pearlSolutionId(solutionData).toString("hex");
}

function submitGatewayProof(context) {
    return new Promise(resolve => pearlProfile.pool.submitBlockRpc.call(pearlProfile.pool, {
        blockTemplate: { height: 123 },
        ...context,
        replyFn(result, status) { resolve({ result, status }); }
    }));
}

function capturePearlLogs(t) {
    const lines = [];
    for (const method of ["log", "error"]) t.mock.method(console, method, line => lines.push(line));
    return lines;
}

function isolatedPearlProfile() {
    const filename = require.resolve("../../../lib/coins/pearl.js");
    const previous = require.cache[filename];
    delete require.cache[filename];
    try { return require(filename); }
    finally { require.cache[filename] = previous; }
}

function assertPearlLogCorrelation(line, height, job) {
    assert.ok(line.includes(`pid=${process.pid} `));
    assert.ok(line.includes(`height=${height} `));
    assert.ok(line.includes(`job=${job} `));
    assert.match(line, new RegExp(`\\bsolution=${PEARL_SOLUTION_ID}(?: |$)`));
}

function workerRecipeFixture(header) {
    const coinbase = Buffer.from("0100000001000000000000000000000000000000000000000000000000000000000000000000", "hex");
    const offset = coinbase.length - 1;
    const branch = Buffer.alloc(0);
    const baseHeader = blockTemplate.derivePearlWorkerHeader(header, coinbase, offset, branch, 0);
    return {
        header: baseHeader,
        recipe: {
            worker_coinbase_bytes: coinbase.toString("base64"),
            worker_coinbase_offset: offset,
            worker_merkle_branch: ""
        }
    };
}

function pearlShareFixture({ claim = {}, verifier, networkDifficulty = 2, shareDifficulty = 1, nativeAdjustmentFactor = 1 }) {
    const networkTarget = pearl.targetForDifficulty(networkDifficulty);
    const shareTarget = pearl.targetForDifficulty(shareDifficulty);
    assert.ok(networkTarget);
    assert.ok(shareTarget);
    const proof = Buffer.from("pearl-proof");
    const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
    header.writeUInt32LE(pearl.targetToCompact(networkTarget.target), 72);
    const calls = { identity: [], invalid: [], trusted: 0, verifier: 0, verified: [], walletTrust: 0 };
    const identityConfig = validPearlVerifierConfig(nativeAdjustmentFactor);
    const verifierResult = verifier && verifier.valid === true
        ? { full: true, solution_data: PEARL_SOLUTION_DATA.toString("hex"), ...verifier }
        : verifier;
    const context = {
        blockTemplate: { header: header.toString("base64"), target: networkTarget.targetDecimal },
        params: { plain_proof: proof, ...claim },
        job: {
            incomplete_header_bytes: header.toString("base64"),
            target: Buffer.from(shareTarget.targetHex, "hex").toString("base64"),
            targetHex: shareTarget.targetHex,
            targetDecimal: shareTarget.targetDecimal,
            difficulty: shareDifficulty
        },
        miner: { payout: "miner" },
        coinFuncs: {
            pearlSolutionId(wireHeader, wireProof) {
                calls.identity.push({ wireHeader, wireProof });
                assert.equal(Buffer.isBuffer(wireProof), true);
                return { valid: true, solution_id: PEARL_SOLUTION_ID, config: identityConfig };
            },
            pearlSolutionIdFromData,
            verifyPearlAsync(_header, _proof, _target, _miner, callback) {
                calls.verifier += 1;
                callback(verifierResult);
            }
        },
        invalidShare() { return "invalid"; },
        processShareCB(result) { calls.invalid.push(result); },
        addWalletTrust() { calls.walletTrust += 1; },
        verifyShareCB(...args) { calls.verified.push(args); }
    };
    return { calls, context, networkTarget, proof, shareTarget };
}

test.describe("pool coin helpers: Pearl", { concurrency: false }, () => {
    test("uses the contiguous daemon RPC and mining gateway ports", () => {
        assert.equal(pearl.PEARL_PORT, 44109);
        assert.equal(pearl.PEARL_GATEWAY_PORT, 44111);
    });

    test("maps the established fixed-coin selector to canonical PearlHash accounting", () => {
        assert.deepEqual(pearlProfile.minerAlgoAliases, { pearlhash: ["pearl", "pearlhash"] });
        assert.deepEqual(pearlProfile.perf.aliases, ["pearlhash", "pearl"]);
        assert.equal(pearlProfile.pool.hashesPerDifficulty, 1_000_000);
    });

    test("accepts bounded uncompressed proofs without magic-byte guessing", () => {
        const rawWithGzipMagic = Buffer.from([0x1f, 0x8b, 0, 0]);
        assert.deepEqual(pearl.decodePearlProof(rawWithGzipMagic.toString("base64")), rawWithGzipMagic);

        const proof = Buffer.from("pearl-proof");
        assert.deepEqual(pearl.decodePearlProof(proof.toString("base64")), proof);
        assert.equal(pearl.decodePearlProof("not-base64"), null);
    });

    test("validates a maximum-size proof linearly without accepting non-canonical padding", () => {
        const encoded = Buffer.alloc(pearl.PEARL_MAX_PROOF_BYTES).toString("base64");
        assert.equal(encoded.length, pearl.PEARL_MAX_PROOF_BASE64_CHARS);
        assert.equal(pearl.isCanonicalBase64(encoded), true);
        assert.equal(pearl.decodePearlProof(encoded)?.length, pearl.PEARL_MAX_PROOF_BYTES);
        assert.equal(pearl.isCanonicalBase64("AB=="), false);
        assert.equal(pearl.isCanonicalBase64("AAB="), false);
    });

    test("decodes accepted proofs once into an uncompressed buffer", () => {
        const rawProof = Buffer.from("pearl-proof");
        const proof = rawProof.toString("base64");
        for (const proof_encoding of [undefined, "none"]) {
            const params = { job_id: 7, plain_proof: proof, ...(proof_encoding ? { proof_encoding } : {}) };
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params, wireParams: {} }), true);
            assert.equal(params.job_id, "7");
            assert.deepEqual(params.plain_proof, rawProof);
        }
        const gzipParams = {
            job_id: "7",
            plain_proof: zlib.gzipSync(rawProof).toString("base64"),
            proof_encoding: "gzip"
        };
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params: gzipParams, wireParams: {} }), true);
        assert.deepEqual(gzipParams, { job_id: "7", plain_proof: rawProof });

        for (const proof_encoding of ["raw", "zlib"]) {
            const params = { job_id: "7", plain_proof: proof, proof_encoding };
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params, wireParams: {} }), false);
        }
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({
            params: { job_id: "7", plain_proof: proof, proof_encoding: "gzip" }, wireParams: {}
        }), false);
    });

    test("bounds gzip proof expansion", () => {
        const oversized = zlib.gzipSync(Buffer.alloc(pearl.PEARL_MAX_PROOF_BYTES + 1));
        assert.equal(pearl.decodePearlProof(oversized.toString("base64"), "gzip"), null);
        assert.equal(pearl.decodePearlProof(zlib.gzipSync(Buffer.from("proof")).toString("base64"), "gzip")?.toString(), "proof");
    });

    test("retains validated miner gzip for gateway forwarding with either local or remote verification", () => {
        const previousConfig = global.config;
        const raw = Buffer.alloc(4096, 0x42);
        const compressed = zlib.gzipSync(raw, { level: 9 });
        try {
            for (const enabled of [false, true]) {
                global.config = { ...previousConfig,
                    verify_shares_host: enabled ? ["127.0.0.1", "verifier.example"] : ["localhost", "127.0.0.1", "::1"] };
                for (const implicit of [false, true]) {
                    const params = { job_id: "job", plain_proof: compressed.toString("base64"),
                        ...(implicit ? {} : { proof_encoding: "gzip" }) };
                    assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params, wireParams: {},
                        miner: { pearlProofGzip: implicit } }), true);
                    assert.deepEqual(params.plain_proof, raw);
                    assert.deepEqual(pearl.getPearlProofGzip(params.plain_proof), compressed);
                    assert.equal(pearlProfile.pool.getTrustedQueueRetainedBytes(params), raw.length + compressed.length);
                }
            }
        } finally {
            global.config = previousConfig;
        }
    });

    test("gateway packing reuses validated miner gzip byte-for-byte and caches packed raw proofs", async () => {
        const raw = Buffer.alloc(64 * 1024, 0x42);
        const original = zlib.gzipSync(raw, { level: 9 });
        original.writeUInt32LE(123, 4);
        const decoded = pearl.decodePearlProof(original.toString("base64"), "gzip", false, true);
        const nativeGzip = zlib.gzip;
        let calls = 0;
        zlib.gzip = function countGzip(...args) { calls += 1; return nativeGzip(...args); };
        const pack = proof => new Promise((resolve, reject) => pearl.packPearlGatewayProof(proof,
            (error, packed) => error ? reject(error) : resolve(packed)));
        try {
            assert.strictEqual(await pack(decoded), pearl.getPearlProofGzip(decoded));
            assert.deepEqual(await pack(decoded), original);
            assert.equal(calls, 0);
            const packed = await pack(raw);
            assert.deepEqual(zlib.gunzipSync(packed), raw);
            assert.equal(calls, 1);
            assert.strictEqual(await pack(raw), packed);
            assert.equal(calls, 1);
            assert.deepEqual(raw, Buffer.alloc(raw.length, 0x42));
        } finally {
            zlib.gzip = nativeGzip;
        }
    });

    test("gateway packing bounds concurrent compression and releases its budget on failures", () => {
        const nativeGzip = zlib.gzip;
        const callbacks = [];
        const errors = [];
        zlib.gzip = function deferGzip(_proof, _options, callback) { callbacks.push(callback); };
        const submit = () => pearl.packPearlGatewayProof(Buffer.alloc(pearl.PEARL_MAX_PROOF_BYTES), error => errors.push(error));
        try {
            submit();
            submit();
            submit();
            assert.equal(callbacks.length, 2);
            assert.match(errors[0].message, /busy/);
            callbacks.shift()(new Error("compression failed"));
            submit();
            assert.equal(callbacks.length, 2, "released budget admits a later proof");
            for (const callback of callbacks) callback(new Error("test cleanup"));
            zlib.gzip = function throwGzip() { throw new Error("native failure"); };
            submit();
            assert.match(errors.at(-1).message, /compression failed/);
        } finally {
            zlib.gzip = nativeGzip;
        }
    });

    test("v2 sessions accept implicit gzip while keeping raw and explicit encodings compatible", () => {
        const rawProof = Buffer.from("pearl-proof");
        const compressedProof = zlib.gzipSync(rawProof);
        const miner = { pearlProofGzip: true };
        const implicit = { job_id: "7", plain_proof: compressedProof.toString("base64") };
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params: implicit, wireParams: {}, miner }), true);
        assert.deepEqual(implicit.plain_proof, rawProof);

        for (const proof_encoding of [undefined, "none"]) {
            const raw = { job_id: "7", plain_proof: rawProof.toString("base64"), ...(proof_encoding ? { proof_encoding } : {}) };
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params: raw, wireParams: {}, miner }), true);
            assert.deepEqual(raw.plain_proof, rawProof);
        }

        const explicitNone = { job_id: "7", plain_proof: compressedProof.toString("base64"), proof_encoding: "none" };
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params: explicitNone, wireParams: {}, miner }), true);
        assert.deepEqual(explicitNone.plain_proof, compressedProof);
        assert.deepEqual(pearl.decodePearlProof(compressedProof.toString("base64")), compressedProof);
    });

    test("v2 implicit gzip rejects malformed streams and oversized expansion", () => {
        const rawProof = Buffer.from("pearl-proof");
        const compressedProof = zlib.gzipSync(rawProof);
        const oversized = zlib.gzipSync(Buffer.alloc(pearl.PEARL_MAX_PROOF_BYTES + 1));
        for (const proof of [compressedProof.subarray(0, compressedProof.length - 1), oversized]) {
            const params = { job_id: "7", plain_proof: proof.toString("base64") };
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({
                params, wireParams: {}, miner: { pearlProofGzip: true }
            }), false);
        }
        const rawWithPartialMagic = Buffer.from([0x1f, 0x8b, 0, 0]);
        assert.deepEqual(pearl.decodePearlProof(rawWithPartialMagic.toString("base64"), undefined, true), rawWithPartialMagic);
    });

    test("named Pearl authorization advertises v2 without changing boolean success or legacy login", () => {
        let jobs = 0;
        const miner = { sendBestCoinJob() { jobs += 1; } };
        const replies = [];
        pearlProfile.pool.sendNamedLoginResult({ miner, sendReply(...args) { replies.push(args); } });
        assert.deepEqual(replies, [[null, true, { type: "v2" }]]);
        assert.equal(miner.pearlProofGzip, true);
        assert.equal(jobs, 1);

        const legacyMiner = { sendBestCoinJob() { jobs += 1; } };
        pearlProfile.pool.sendLoginResult({ miner: legacyMiner, sendReply(...args) { replies.push(args); } });
        assert.deepEqual(replies[1], [null, true]);
        assert.equal(legacyMiner.pearlProofGzip, undefined);
        assert.equal(jobs, 2);
    });

    test("accepts and strips only the current submit certificate version", () => {
        const proof = Buffer.from("pearl-proof").toString("base64");
        const params = {
            job_id: 7,
            plain_proof: proof,
            cert_version: pearl.PEARL_CERT_VERSION,
            future_extension: { ignored: true }
        };
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params, wireParams: {} }), true);
        assert.equal(params.job_id, "7");
        assert.deepEqual(params.plain_proof, Buffer.from("pearl-proof"));

        for (const cert_version of [2, 4, "3", null]) {
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({
                params: { job_id: "7", plain_proof: proof, cert_version }, wireParams: {}
            }), false);
        }
    });

    test("normalizes and validates optional Pearl claim fields", () => {
        const proof = Buffer.from("pearl-proof").toString("base64");
        const jackpot = "ab".repeat(32).toUpperCase();
        const params = { job_id: 7, plain_proof: proof, jackpot, adjustment_factor: 7 };
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params, wireParams: {} }), true);
        assert.equal(params.jackpot, jackpot.toLowerCase());
        assert.equal(params.adjustment_factor, 7);

        const invalidClaims = [
            { jackpot },
            { adjustment_factor: 1 },
            { jackpot: "a".repeat(63), adjustment_factor: 1 },
            { jackpot: "gg".repeat(32), adjustment_factor: 1 },
            { jackpot: "00".repeat(32), adjustment_factor: 0 },
            { jackpot: "00".repeat(32), adjustment_factor: 0x1_0000_0000 }
        ];
        for (const claim of invalidClaims) {
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({
                params: { job_id: "7", plain_proof: proof, ...claim }, wireParams: {}
            }), false);
        }
    });

    test("uses the native semantic identity across job ids and proof encodings", () => {
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES, 7).toString("base64");
        const canonical = Buffer.from("canonical-proof");
        const legacy = Buffer.from("legacy-proof");
        const coinFuncs = {
            pearlSolutionId(wireHeader, wireProof) {
                assert.equal(wireHeader, Buffer.alloc(pearl.PEARL_HEADER_BYTES, 7).toString("hex"));
                assert.equal(Buffer.isBuffer(wireProof), true);
                return { valid: true, solution_id: PEARL_SOLUTION_ID, config: validPearlVerifierConfig(1) };
            }
        };
        const key = (jobId, proof) => {
            const params = { job_id: jobId, plain_proof: proof.toString("base64") };
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({
                coinFuncs,
                job: { id: jobId, incomplete_header_bytes: header },
                params,
                wireParams: {}
            }), true);
            return pearlProfile.pool.submissionKey({ coinFuncs, miner: {}, job: { id: jobId, incomplete_header_bytes: header }, params });
        };

        assert.equal(key("job-a", canonical), PEARL_SOLUTION_ID);
        assert.equal(key("job-b", legacy), PEARL_SOLUTION_ID);
    });

    test("does not include claimed jackpot or factor in the semantic key", () => {
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES, 9).toString("base64");
        const coinFuncs = {
            pearlSolutionId() {
                return { valid: true, solution_id: PEARL_SOLUTION_ID, config: validPearlVerifierConfig(7) };
            }
        };
        const key = claim => {
            const params = { job_id: "job", plain_proof: Buffer.from("proof").toString("base64"), ...claim };
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({
                coinFuncs,
                job: { id: "job", incomplete_header_bytes: header },
                params,
                wireParams: {}
            }), true);
            return pearlProfile.pool.submissionKey({ coinFuncs, miner: {}, job: { id: "job", incomplete_header_bytes: header }, params });
        };
        assert.equal(key({ jackpot: "00".repeat(32), adjustment_factor: 7 }), key({ jackpot: "ff".repeat(32), adjustment_factor: 7 }));
    });

    test("rejects an invalid native identity through normal submit validation", () => {
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES, 3).toString("base64");
        const params = { job_id: "job", plain_proof: Buffer.from("proof").toString("base64") };
        const coinFuncs = { pearlSolutionId() { return { valid: false }; } };
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({
            coinFuncs,
            job: { id: "job", incomplete_header_bytes: header },
            params,
            wireParams: {}
        }), true);
        assert.equal(pearlProfile.pool.validateSubmitParams({ params, job: { id: "job", incomplete_header_bytes: header }, coinFuncs }), false);
    });

    test("does not reuse a cached identity after failed renormalization", () => {
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES, 4).toString("base64");
        const params = { job_id: "job", plain_proof: Buffer.from("proof").toString("base64") };
        const coinFuncs = {
            pearlSolutionId() {
                return { valid: true, solution_id: PEARL_SOLUTION_ID, config: validPearlVerifierConfig(1) };
            }
        };
        const context = { coinFuncs, job: { id: "job", incomplete_header_bytes: header }, params, wireParams: {} };
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams(context), true);
        assert.equal(pearlProfile.pool.parseMiningSubmitParams({ params }), true);
        params.plain_proof = "not-base64";
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams(context), false);
        assert.equal(pearlProfile.pool.parseMiningSubmitParams({ params }), false);
    });

    test("rejects zero or oversized native adjustment factors", () => {
        for (const adjustment_factor of [0, 0x1_0000_0000]) {
            assert.equal(pearl.parsePearlSolutionIdResult({
                valid: true,
                solution_id: PEARL_SOLUTION_ID,
                config: validPearlVerifierConfig(adjustment_factor)
            }), null);
            assert.equal(pearl.parsePearlVerifierResult({
                valid: true,
                full: true,
                solution_data: PEARL_SOLUTION_DATA.toString("hex"),
                candidate: true,
                jackpot: "00".repeat(32),
                config: validPearlVerifierConfig(adjustment_factor)
            }), null);
        }
    });

    test("accepts only full bounded versioned verifier solution data", () => {
        const base = {
            valid: true,
            full: true,
            solution_data: PEARL_SOLUTION_DATA.toString("hex"),
            candidate: true,
            jackpot: "00".repeat(32),
            config: validPearlVerifierConfig(1)
        };
        assert.ok(pearl.parsePearlVerifierResult(base));
        for (const solution_data of ["", "01f", "02", "01zz", "01".repeat(16 * 1024 + 1)]) {
            assert.equal(pearl.parsePearlVerifierResult({ ...base, solution_data }), null);
        }
        assert.equal(pearl.parsePearlVerifierResult({ ...base, full: false }), null);
        const withoutFull = { ...base };
        delete withoutFull.full;
        assert.equal(pearl.parsePearlVerifierResult(withoutFull), null);
    });

    test("does not call native identity work for an unknown job", () => {
        let identityCalls = 0;
        const params = { job_id: "missing", plain_proof: Buffer.from("proof").toString("base64") };
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({
            coinFuncs: { pearlSolutionId() { identityCalls += 1; return { valid: false }; } },
            params,
            wireParams: {}
        }), true);
        assert.equal(identityCalls, 0);
    });

    test("normalizes the standard Pearl object authorize shape", () => {
        const params = { wallet: "wallet", worker: "worker", pass: "x~pearl" };
        assert.equal(pearlProfile.pool.normalizeNamedAuthorizeParams({
            params,
            port: pearl.PEARL_PORT,
            profile: pearlProfile
        }), true);
        assert.equal(params.login, "wallet");
        assert.equal(params.rigid, "worker");
        assert.deepEqual(params.algo, ["pearlhash"]);
    });

    test("normalizes the SRBMiner Pearl authorize variant without a password", () => {
        const params = { wallet: "wallet", worker: "worker", agent: "SRBMiner-MULTI/3.6.7", type: "pearlhash" };
        assert.equal(pearlProfile.pool.normalizeNamedAuthorizeParams({
            params,
            port: pearl.PEARL_PORT,
            profile: pearlProfile
        }), true);
        assert.equal(params.pass, "x");
        assert.equal(params.login, "wallet");
        assert.equal(params.rigid, "worker");
        assert.equal(params.type, undefined);
    });

    test("derives exact little-endian share targets from normalized difficulty", () => {
        const result = pearl.targetForDifficulty(2);
        assert.ok(result);
        assert.equal(result.work, 2_000_000n);
        assert.equal(BigInt(`0x${Buffer.from(result.targetHex, "hex").reverse().toString("hex")}`), result.target);
        assert.equal(result.targetDecimal, result.target.toString(10));
    });

    test("derives targets above the JavaScript safe-integer work boundary", () => {
        const difficulty = (Number.MAX_SAFE_INTEGER + 1) / pearl.PEARL_HASHES_PER_DIFFICULTY;
        const result = pearl.targetForDifficulty(difficulty);
        assert.ok(result);
        assert.equal(result.work, BigInt(Math.ceil(difficulty * pearl.PEARL_HASHES_PER_DIFFICULTY)));
        assert.ok(result.target > 0n);
    });

    test("builds the established Pearl miner wire job from the gateway template", () => {
        const networkTarget = pearl.targetForDifficulty(1);
        assert.ok(networkTarget);
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
        header.writeUInt32LE(pearl.targetToCompact(networkTarget.target), 72);
        const headerBase64 = header.toString("base64");
        const newJob = { id: "pearl-job" };
        const payload = pearlProfile.pool.buildJobPayload({
            blockTemplate: {
                header: headerBase64,
                incomplete_header_bytes: headerBase64,
                cert_version: pearl.PEARL_CERT_VERSION,
                height: 123
            },
            coinDiff: 2,
            newJob
        });
        const shareTarget = pearl.targetForDifficulty(2);
        assert.ok(shareTarget);
        assert.deepEqual(payload, {
            header: header.toString("hex"),
            job_id: "pearl-job",
            target: shareTarget.target.toString(16).padStart(64, "0"),
            cert_version: pearl.PEARL_CERT_VERSION,
            proof_encodings: ["none", "gzip"]
        });
        assert.equal(newJob.targetHex, shareTarget.targetHex);
        assert.equal(payload.target, Buffer.from(newJob.targetHex, "hex").reverse().toString("hex"));
        assert.equal(newJob.incomplete_header_bytes, headerBase64);
        assert.equal(newJob.cert_version, pearl.PEARL_CERT_VERSION);
    });

    test("fails closed when adjustment would overflow a 256-bit target", () => {
        assert.equal(pearl.adjustedNetworkTarget(pearl.UINT256_MAX.toString(10), 2), null);
        assert.equal(pearl.isPearlNetworkCandidate("00".repeat(32), pearl.UINT256_MAX.toString(10), 2), false);
    });

    test("normalizes daemon difficulty from the exact Pearl target for hash-factor accounting", async () => {
        const target = pearl.targetForDifficulty(2);
        assert.ok(target);
        const compact = pearl.targetToCompact(target.target);
        assert.ok(compact);
        const previousHash = "12".repeat(32);
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
        Buffer.from(previousHash, "hex").reverse().copy(header, 4);
        header.writeUInt32LE(compact, 72);
        const { header: baseHeader, recipe } = workerRecipeFixture(header);
        const parsed = pearl.parseMiningHeader(baseHeader.toString("base64"));
        assert.ok(parsed);
        const originalGatewayRequest = pearl.gatewayRequest;
        pearl.gatewayRequest = function mockGatewayRequest(method, params, callback) {
            assert.equal(method, "getMiningInfo");
            assert.deepEqual(params, {});
            callback(null, { result: {
                cert_version: pearl.PEARL_CERT_VERSION,
                incomplete_header_bytes: baseHeader.toString("base64"),
                target_decimal: parsed.targetDecimal,
                expected_reward: 50,
                ...recipe
            } });
        };
        try {
            const normalized = await new Promise((resolve, reject) => {
                pearlProfile.rpc.getLastBlockHeader({
                    port: pearl.PEARL_PORT,
                    profile: pearlProfile,
                    noErrorReport: true,
                    runtime: { support: { rpcPortDaemon2(port, path, request, callback) {
                        assert.equal(port, pearl.PEARL_PORT);
                        assert.equal(path, "");
                        assert.deepEqual(request, {
                            id: "0", jsonrpc: "2.0", method: "getblockheader", params: [previousHash, true]
                        });
                        callback({ result: { height: 99, hash: previousHash, difficulty: 1 } });
                    } } , coinFuncs: { uniqueWorkerId: 7 }},
                    callback(error, result) { if (error) reject(error); else resolve(result); }
                });
            });
            assert.equal(normalized.difficulty, parsed.difficulty);
            assert.equal(normalized.reward, 50);
        } finally {
            pearl.gatewayRequest = originalGatewayRequest;
        }
    });

    test("one gateway template carries enough data for each worker header", async () => {
        const target = pearl.targetForDifficulty(2);
        assert.ok(target);
        const seedHeader = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
        seedHeader.writeUInt32LE(pearl.targetToCompact(target.target), 72);
        const { header: baseHeader, recipe } = workerRecipeFixture(seedHeader);
        const parsedBase = pearl.parseMiningHeader(baseHeader.toString("base64"));
        assert.ok(parsedBase);
        const originalGatewayRequest = pearl.gatewayRequest;
        pearl.gatewayRequest = function mockGatewayRequest(method, params, callback) {
            assert.equal(method, "getMiningInfo");
            assert.deepEqual(params, {});
            callback(null, { result: {
                cert_version: pearl.PEARL_CERT_VERSION,
                incomplete_header_bytes: baseHeader.toString("base64"),
                target_decimal: parsedBase.targetDecimal,
                expected_reward: 50,
                ...recipe
            } });
        };
        try {
            const base = await new Promise((resolve, reject) => {
                pearlProfile.rpc.getBlockTemplate({
                    port: pearl.PEARL_PORT,
                    runtime: { support: { rpcPortDaemon2(_port, _path, _request, callback) {
                        callback({ result: { height: 99, hash: parsedBase.prevHash } });
                    } } },
                    callback(result, error) { if (error) reject(error); else resolve(result); }
                });
            });
            assert.equal(base.hash, baseHeader.toString("base64"));
            assert.equal(base.height, 100);
            assert.deepEqual(pearl.decodeWorkerRecipe(base), pearl.decodeWorkerRecipe(recipe));
        } finally {
            pearl.gatewayRequest = originalGatewayRequest;
        }
    });

    test("reads owned coinbase rewards and preserves orphan and maturity status", async () => {
        const hash = "ab".repeat(32);
        async function lookup({ confirmations = 101, destination = "pool-address", rawtx = true, malformed = false } = {}) {
            const calls = [];
            const result = await new Promise(resolve => pearlProfile.rpc.getAnyBlockHeaderByHash({
                port: pearl.PEARL_PORT, profile: pearlProfile, blockHash: hash, isOurBlock: true,
                runtime: { getPoolAddress() { return "pool-address"; }, support: { rpcPortDaemon2(_port, _path, request, callback) {
                    calls.push(request.method);
                    if (request.method === "getblockheader") return callback({ result: { hash, height: 100, confirmations } });
                    const coinbase = { vin: [{ coinbase: "00" }], vout: [
                        { value: malformed ? NaN : 12.34567891, scriptPubKey: { address: destination } },
                        { value: 1, scriptPubKey: { addresses: ["other-address"] } }
                    ] };
                    callback({ result: { hash, [rawtx ? "rawtx" : "tx"]: [coinbase] } });
                } } }, callback(error, header) { resolve({ error, header, calls }); }
            }));
            return result;
        }
        for (const rawtx of [true, false]) {
            const { error, header } = await lookup({ rawtx });
            assert.equal(error, null);
            assert.equal(header.reward, 1234567891);
            assert.equal(header.depth, 101);
        }
        assert.equal((await lookup({ destination: "other-address" })).error, true);
        assert.equal((await lookup({ malformed: true })).error, true);
        const orphan = await lookup({ confirmations: -1 });
        assert.equal(orphan.header.orphan_status, true);
        assert.deepEqual(orphan.calls, ["getblockheader"]);
        assert.equal(pearlProfile.rpc.unlockConfirmationDepth, 100);
    });

    test("uses complete JSON-RPC envelopes for pearld header lookups", async () => {
        const blockHash = "34".repeat(32);
        const calls = [];
        const support = { rpcPortDaemon2(port, path, request, callback) {
            assert.equal(port, pearl.PEARL_PORT);
            assert.equal(path, "");
            calls.push(request);
            if (request.method === "getblockhash") return callback({ result: blockHash });
            return callback({ result: { height: 7, hash: blockHash } });
        } };
        const context = {
            port: pearl.PEARL_PORT,
            profile: pearlProfile,
            noErrorReport: true,
            runtime: { support }
        };
        const byHeight = await new Promise((resolve, reject) => pearlProfile.rpc.getBlockHeaderById({
            ...context,
            blockId: 7,
            callback(error, result) { if (error) reject(error); else resolve(result); }
        }));
        const byHash = await new Promise((resolve, reject) => pearlProfile.rpc.getAnyBlockHeaderByHash({
            ...context,
            blockHash,
            callback(error, result) { if (error) reject(error); else resolve(result); }
        }));
        assert.equal(byHeight.height, 7);
        assert.equal(byHash.height, 7);
        assert.deepEqual(calls, [
            { id: "0", jsonrpc: "2.0", method: "getblockhash", params: [7] },
            { id: "0", jsonrpc: "2.0", method: "getblockheader", params: [blockHash, true] },
            { id: "0", jsonrpc: "2.0", method: "getblockheader", params: [blockHash, true] }
        ]);
    });

    test("accepts a claimed ordinary share through the trusted-share path", () => {
        const fixture = pearlShareFixture({
            claim: { jackpot: pearl.targetForDifficulty(1).targetHex, adjustment_factor: 1 },
            verifier: { valid: true, candidate: true, jackpot: "00".repeat(32), config: validPearlVerifierConfig(1) }
        });
        fixture.context.tryTrustedShare = onTrustedShare => {
            fixture.calls.trusted += 1;
            onTrustedShare();
            return true;
        };

        assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
        assert.equal(fixture.calls.trusted, 1);
        assert.equal(fixture.calls.verifier, 0);
        assert.deepEqual(fixture.calls.verified, [[1, null, null, true, false, false]]);
        assert.deepEqual(fixture.calls.invalid, []);
        assert.equal(fixture.calls.walletTrust, 0);
    });

    test("rejects a trusted claim whose factor differs from native identity config", () => {
        const fixture = pearlShareFixture({
            claim: { jackpot: pearl.targetForDifficulty(1).targetHex, adjustment_factor: 1 },
            nativeAdjustmentFactor: 2,
            verifier: { valid: true, candidate: true, jackpot: "00".repeat(32), config: validPearlVerifierConfig(2) }
        });
        fixture.context.tryTrustedShare = onTrustedShare => {
            fixture.calls.trusted += 1;
            onTrustedShare();
            return true;
        };

        assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
        assert.equal(fixture.calls.trusted, 0);
        assert.equal(fixture.calls.verifier, 0);
        assert.deepEqual(fixture.calls.invalid, ["invalid"]);
    });

    test("rejects a job header that differs from its block template", () => {
        const fixture = pearlShareFixture({
            claim: { jackpot: pearl.targetForDifficulty(1).targetHex, adjustment_factor: 1 },
            verifier: { valid: true, candidate: true, jackpot: "00".repeat(32), config: validPearlVerifierConfig(1) }
        });
        fixture.context.job.incomplete_header_bytes = Buffer.alloc(pearl.PEARL_HEADER_BYTES, 1).toString("base64");
        fixture.context.tryTrustedShare = () => {
            assert.fail("mismatched headers must fail before trust");
        };

        assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
        assert.equal(fixture.calls.verifier, 0);
        assert.deepEqual(fixture.calls.invalid, ["invalid"]);
    });

    test("fully verifies a claimed network candidate without trying trusted shares", () => {
        const fixture = pearlShareFixture({
            claim: { jackpot: "00".repeat(32), adjustment_factor: 1 },
            verifier: {
                valid: true,
                candidate: true,
                jackpot: "00".repeat(32),
                config: validPearlVerifierConfig(1)
            }
        });
        fixture.context.tryTrustedShare = () => {
            fixture.calls.trusted += 1;
            assert.fail("network candidates must be fully verified");
        };

        assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
        assert.equal(fixture.calls.trusted, 0);
        assert.equal(fixture.calls.verifier, 1);
        assert.deepEqual(fixture.calls.verified, [[1, null, fixture.proof.toString("base64"), false, true, true]]);
        assert.deepEqual(fixture.calls.invalid, []);
        assert.equal(fixture.calls.walletTrust, 1);
    });

    test("credits fully verified ordinary shares with or without jackpot claims", () => {
        const jackpot = pearl.targetForDifficulty(1).targetHex;
        for (const claim of [{}, { jackpot, adjustment_factor: 1 }]) {
            const fixture = pearlShareFixture({
                claim,
                verifier: { valid: true, candidate: true, jackpot, config: validPearlVerifierConfig(1) }
            });
            fixture.context.tryTrustedShare = () => false;
            pearlProfile.pool.verifySpecialShare(fixture.context);
            assert.equal(fixture.calls.verifier, 1);
            assert.equal(fixture.calls.walletTrust, 1);
            assert.deepEqual(fixture.calls.verified, [[1, null, null, false, false, false]]);
        }
    });

    test("does not credit invalid, unavailable, incomplete or mismatched verification", () => {
        const results = [
            null,
            false,
            { valid: false },
            { valid: true, full: false, candidate: true, jackpot: "00".repeat(32), config: validPearlVerifierConfig(1) },
            { valid: true, candidate: false, jackpot: "ff".repeat(32), config: validPearlVerifierConfig(1) },
            { valid: true, candidate: true, jackpot: "00".repeat(32), config: validPearlVerifierConfig(2) },
            { valid: true, candidate: true, solution_data: "01ab", jackpot: "00".repeat(32), config: validPearlVerifierConfig(1) }
        ];
        for (const verifier of results) {
            const fixture = pearlShareFixture({ verifier });
            pearlProfile.pool.verifySpecialShare(fixture.context);
            assert.equal(fixture.calls.walletTrust, 0);
            assert.deepEqual(fixture.calls.verified, []);
        }
        const fixture = pearlShareFixture({ verifier: null });
        fixture.context.coinFuncs.verifyPearlAsync = (_header, _proof, _target, _miner, callback) => {
            callback({ valid: true }, "verify-host-error");
        };
        pearlProfile.pool.verifySpecialShare(fixture.context);
        assert.equal(fixture.calls.walletTrust, 0);
        assert.deepEqual(fixture.calls.verified, []);
    });

    test("ignores repeated full verifier callbacks after success or failure", () => {
        for (const firstInvalid of [false, true]) {
            const fixture = pearlShareFixture({ verifier: null });
            const valid = {
                valid: true, full: true, solution_data: PEARL_SOLUTION_DATA.toString("hex"),
                candidate: true, jackpot: "00".repeat(32), config: validPearlVerifierConfig(1)
            };
            fixture.context.coinFuncs.verifyPearlAsync = (_header, _proof, _target, _miner, callback) => {
                callback(firstInvalid ? { valid: false } : valid);
                callback(valid);
            };
            pearlProfile.pool.verifySpecialShare(fixture.context);
            assert.equal(fixture.calls.walletTrust, firstInvalid ? 0 : 1);
            assert.equal(fixture.calls.verified.length, firstInvalid ? 0 : 1);
            assert.equal(fixture.calls.invalid.length, firstInvalid ? 1 : 0);
        }
    });

    test("rejects a full verifier result with a different solution id", () => {
        const fixture = pearlShareFixture({
            claim: { jackpot: "00".repeat(32), adjustment_factor: 1 },
            verifier: {
                valid: true,
                solution_data: Buffer.from([1, ...Buffer.alloc(32, 0xab)]).toString("hex"),
                candidate: true,
                jackpot: "00".repeat(32),
                config: validPearlVerifierConfig(1)
            }
        });
        fixture.context.tryTrustedShare = () => {
            fixture.calls.trusted += 1;
            assert.fail("network candidates must be fully verified");
        };

        assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
        assert.equal(fixture.calls.verifier, 1);
        assert.deepEqual(fixture.calls.invalid, ["invalid"]);
        assert.deepEqual(fixture.calls.verified, []);
        assert.equal(fixture.calls.walletTrust, 0);
    });

    test("rejects claims outside the assigned share target before verification", () => {
        const fixture = pearlShareFixture({
            claim: { jackpot: "ff".repeat(32), adjustment_factor: 1 },
            verifier: { valid: true, candidate: true, jackpot: "ff".repeat(32), config: validPearlVerifierConfig(1) }
        });

        assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
        assert.equal(fixture.calls.verifier, 0);
        assert.deepEqual(fixture.calls.invalid, ["invalid"]);
        assert.deepEqual(fixture.calls.verified, []);
    });

    test("invalidates verifier results whose jackpot or factor differs from the claim", () => {
        const networkTarget = pearl.targetForDifficulty(2);
        assert.ok(networkTarget);
        const cases = [
            {
                claim: { jackpot: networkTarget.targetHex, adjustment_factor: 1 },
                verifier: {
                    valid: true, candidate: true, jackpot: "00".repeat(32), config: validPearlVerifierConfig(1)
                }
            },
            {
                claim: { jackpot: networkTarget.targetHex, adjustment_factor: 2 },
                verifier: {
                    valid: true, candidate: true, jackpot: networkTarget.targetHex, config: validPearlVerifierConfig(1)
                }
            }
        ];
        for (const [index, { claim, verifier }] of cases.entries()) {
            const fixture = pearlShareFixture({ claim, verifier });
            fixture.context.tryTrustedShare = () => {
                fixture.calls.trusted += 1;
                assert.fail("claimed network candidates must not use trusted shares");
            };
            assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
            assert.equal(fixture.calls.trusted, 0);
            assert.equal(fixture.calls.verifier, index === 0 ? 1 : 0);
            assert.deepEqual(fixture.calls.invalid, ["invalid"]);
            assert.deepEqual(fixture.calls.verified, []);
            assert.equal(fixture.calls.walletTrust, 0);
        }
    });

    test("rejects a valid proof that does not meet the assigned share target", () => {
        const parsed = pearl.targetForDifficulty(1);
        assert.ok(parsed);
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
        header.writeUInt32LE(pearl.targetToCompact(parsed.target), 72);
        let invalidCalls = 0;
        let verifiedCalls = 0;
        let verifierWire;
        const context = {
            blockTemplate: { header: header.toString("base64"), target: parsed.targetDecimal },
            params: { plain_proof: Buffer.from("proof") },
            job: {
                incomplete_header_bytes: header.toString("base64"),
                target: Buffer.from(parsed.targetHex, "hex").toString("base64"),
                targetHex: parsed.targetHex,
                difficulty: 1
            },
            miner: { payout: "miner" },
            coinFuncs: {
                pearlSolutionId() {
                    return { valid: true, solution_id: PEARL_SOLUTION_ID, config: validPearlVerifierConfig(128) };
                },
                pearlSolutionIdFromData,
                verifyPearlAsync(wireHeader, _proof, wireTarget, _miner, callback) {
                    verifierWire = { wireHeader, wireTarget };
                    callback({
                        valid: true,
                        full: true,
                        solution_data: PEARL_SOLUTION_DATA.toString("hex"),
                        candidate: false,
                        jackpot: "ff".repeat(32),
                        config: {
                            m: 1, n: 1, k: 128, rank: 128, experts: 0, top_k: 0,
                            expert_index: 0, t_rows: 1, t_cols: 1, adjustment_factor: 128, moe: false
                        }
                    });
                }
            },
            invalidShare() { return "invalid"; },
            processShareCB(result) { assert.equal(result, "invalid"); invalidCalls += 1; },
            verifyShareCB() { verifiedCalls += 1; }
        };
        assert.equal(pearlProfile.pool.verifySpecialShare(context), true);
        assert.equal(verifierWire.wireHeader, header.toString("hex"));
        assert.equal(verifierWire.wireTarget, parsed.targetHex);
        assert.equal(invalidCalls, 1);
        assert.equal(verifiedCalls, 0);
    });

    test("marks an independently verified network winner for block submission", () => {
        const parsed = pearl.targetForDifficulty(1);
        assert.ok(parsed);
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
        header.writeUInt32LE(pearl.targetToCompact(parsed.target), 72);
        const proof = Buffer.from("winning-proof");
        let verifiedArgs;
        const context = {
            blockTemplate: { header: header.toString("base64"), target: parsed.targetDecimal },
            params: { plain_proof: proof },
            job: { incomplete_header_bytes: header.toString("base64"), targetHex: parsed.targetHex, difficulty: 1 },
            miner: { payout: "miner" },
            coinFuncs: {
                pearlSolutionId() {
                    return { valid: true, solution_id: PEARL_SOLUTION_ID, config: validPearlVerifierConfig(128) };
                },
                pearlSolutionIdFromData,
                verifyPearlAsync(_header, _proof, _target, _miner, callback) {
                    callback({
                        valid: true,
                        full: true,
                        solution_data: PEARL_SOLUTION_DATA.toString("hex"),
                        candidate: true,
                        jackpot: "00".repeat(32),
                        proof_id: "12".repeat(32),
                        config: {
                            m: 1, n: 1, k: 128, rank: 128, experts: 0, top_k: 0,
                            expert_index: 0, t_rows: 1, t_cols: 1, adjustment_factor: 128, moe: false
                        }
                    });
                }
            },
            invalidShare() { return "invalid"; },
            processShareCB() { assert.fail("winning proof must reach the verified-share path"); },
            verifyShareCB(...args) { verifiedArgs = args; }
        };
        assert.equal(pearlProfile.pool.verifySpecialShare(context), true);
        assert.deepEqual(verifiedArgs, [1, null, proof.toString("base64"), false, true, true]);
        assert.equal(context.params.pearl_solution_id, PEARL_SOLUTION_ID);
        assert.equal(context.params.pearl_proof_id, "12".repeat(32));
    });

    test("logs every verified network candidate with full correlation, including unclaimed winners", t => {
        const lines = capturePearlLogs(t);
        t.mock.method(Date, "now", () => 100000);
        const profile = isolatedPearlProfile();
        for (const [index, claim] of [
            { jackpot: "00".repeat(32), adjustment_factor: 1 },
            {},
            { jackpot: "00".repeat(32), adjustment_factor: 1 }
        ].entries()) {
            const fixture = pearlShareFixture({ claim,
                verifier: { valid: true, candidate: true, jackpot: "00".repeat(32), config: validPearlVerifierConfig(1) } });
            fixture.context.blockTemplate.height = 321;
            fixture.context.job.id = `candidate-${index}`;
            assert.equal(profile.pool.verifySpecialShare(fixture.context), true);
            assert.equal(fixture.calls.verified.length, 1);
            const line = lines.find(value => value.startsWith("PRL candidate verified:") && value.includes(`job=candidate-${index} `));
            assert.ok(line);
            assertPearlLogCorrelation(line, 321, `candidate-${index}`);
            assert.ok(line.includes(`jackpot=${"00".repeat(32)} `));
            assert.ok(line.includes(`network_target=${fixture.networkTarget.targetDecimal} `));
            assert.match(line, /adjustment_factor=1 network_target_met=true$/);
            assert.equal(lines.join("\n").includes(fixture.proof.toString("base64")), false);
        }
        assert.equal(lines.filter(line => line.startsWith("PRL candidate verified:")).length, 3);
        assert.equal(lines.filter(line => line.startsWith("PRL candidate claimed:")).length, 1);
        const claimed = lines.find(line => line.startsWith("PRL candidate claimed:"));
        assertPearlLogCorrelation(claimed, 321, "candidate-0");
        assert.ok(claimed.includes(`jackpot=${"00".repeat(32)} `));
        assert.match(claimed, /network_target=\d+ adjustment_factor=1$/);
        assert.equal(lines.some(line => line.startsWith("PRL candidate rejected:")), false);
    });

    test("does not add candidate logs to ordinary shares or unclaimed invalid proofs", t => {
        const lines = capturePearlLogs(t);
        const jackpot = pearl.targetForDifficulty(1).targetHex;
        for (const trusted of [false, true]) {
            for (const claim of [{}, { jackpot, adjustment_factor: 1 }]) {
                const fixture = pearlShareFixture({ claim,
                    verifier: { valid: true, candidate: true, jackpot, config: validPearlVerifierConfig(1) } });
                if (trusted) fixture.context.tryTrustedShare = accept => { accept(); return true; };
                pearlProfile.pool.verifySpecialShare(fixture.context);
                assert.equal(fixture.calls.verified.length, 1);
                assert.equal(fixture.calls.verified[0][4], false);
            }
        }
        pearlProfile.pool.verifySpecialShare(pearlShareFixture({ verifier: { valid: false } }).context);
        assert.deepEqual(lines, []);
    });

    test("bounds claimed and rejected candidate logs across repeated failed verification", t => {
        const lines = capturePearlLogs(t);
        const profile = isolatedPearlProfile();
        let now = 100000;
        let claimIndex = 0;
        t.mock.method(Date, "now", () => now);
        function rejectClaim(unavailable = false) {
            const fixture = pearlShareFixture({ claim: { jackpot: "00".repeat(32), adjustment_factor: 1 },
                verifier: { valid: false } });
            fixture.context.blockTemplate.height = 321;
            fixture.context.job.id = `rejected-candidate-${claimIndex++}`;
            fixture.context.miner.payout = `untrusted-wallet-${claimIndex}`;
            if (unavailable) fixture.context.coinFuncs.verifyPearlAsync = (_header, _proof, _target, _miner, callback) =>
                callback(null, "verify-host-error");
            profile.pool.verifySpecialShare(fixture.context);
            assert.equal(fixture.calls.invalid.length, 1);
        }
        for (let index = 0; index < 32; ++index) rejectClaim();
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^PRL candidate claimed:/);
        assertPearlLogCorrelation(lines[0], 321, "rejected-candidate-0");
        assert.match(lines[1], /^PRL candidate rejected:.*stage=verification reason=invalid-proof$/);
        now += 9999;
        rejectClaim();
        assert.equal(lines.length, 2);
        now += 1;
        rejectClaim(true);
        assert.equal(lines.length, 4);
        assertPearlLogCorrelation(lines[2], 321, "rejected-candidate-33");
        assert.match(lines[3], /^PRL candidate rejected:.*stage=verification reason=verifier-unavailable$/);
    });

    test("logs gzip upload sizes and accepted block correlation without proof or miner data", async t => {
        const lines = capturePearlLogs(t);
        const proof = Buffer.from("private-proof-payload-for-logging-test");
        const packed = zlib.gzipSync(proof);
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES, 0x73).toString("base64");
        let now = 100000;
        t.mock.method(Date, "now", () => now);
        t.mock.method(pearl, "packPearlGatewayProof", (_proof, callback) => { now += 2; callback(null, packed); });
        t.mock.method(pearl, "gatewayRequest", (_method, _params, callback) => {
            now += 5;
            callback(null, { result: { status: "accepted", block_hash: "AB".repeat(32) } });
        });
        const response = await submitGatewayProof({
            blockTemplate: { height: 321 }, blockData: proof.toString("base64"),
            params: { plain_proof: proof, pearl_solution_id: PEARL_SOLUTION_ID },
            job: { id: "submitted-candidate", targetDecimal: "1", incomplete_header_bytes: header },
            miner: { payout: "private-wallet", identifier: "private-worker" }
        });
        assert.equal(response.status, 200);
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^PRL submit started:/);
        assertPearlLogCorrelation(lines[0], 321, "submitted-candidate");
        assert.ok(lines[0].endsWith(`encoding=gzip raw_bytes=${proof.length} packed_bytes=${packed.length}`));
        assert.match(lines[1], /^PRL submit accepted:/);
        assertPearlLogCorrelation(lines[1], 321, "submitted-candidate");
        assert.ok(lines[1].endsWith(`block=${"ab".repeat(32)} elapsed_ms=7`));
        const logged = lines.join("\n");
        for (const secret of [proof.toString(), proof.toString("base64"), proof.toString("hex"), packed.toString("base64"),
            header, "private-wallet", "private-worker", "plain_proof"]) assert.equal(logged.includes(secret), false);
    });

    test("logs fixed gateway rejection, timeout and transport reasons without copying error payloads", async t => {
        const lines = capturePearlLogs(t);
        const proof = Buffer.from("private-failed-proof");
        const packed = zlib.gzipSync(proof);
        let failure;
        t.mock.method(pearl, "packPearlGatewayProof", (_proof, callback) => callback(null, packed));
        t.mock.method(pearl, "gatewayRequest", (_method, _params, callback) => {
            if (failure === "timeout") return callback(new Error("Pearl gateway timeout"));
            if (failure === "transport") return callback(new Error(`private-transport\n${proof.toString("base64")}`));
            return callback(null, { error: { message: `private-rejection\n${proof.toString("base64")}` } });
        });
        for (failure of ["rejection", "timeout", "transport"]) {
            const response = await submitGatewayProof({ blockData: proof.toString("base64"),
                params: { plain_proof: proof, pearl_solution_id: PEARL_SOLUTION_ID },
                job: { id: "failed-candidate", targetDecimal: "1" } });
            assert.equal(response.status, failure === "rejection" ? 200 : 0);
        }
        const failed = lines.filter(line => line.startsWith("PRL submit failed:"));
        assert.equal(failed.length, 3);
        for (const line of failed) assertPearlLogCorrelation(line, 123, "failed-candidate");
        assert.match(failed[0], /stage=gateway reason=proof-not-accepted elapsed_ms=\d+$/);
        assert.match(failed[1], /stage=gateway reason=timeout elapsed_ms=\d+$/);
        assert.match(failed[2], /stage=gateway reason=request-failed elapsed_ms=\d+$/);
        assert.equal(lines.join("\n").includes("private-"), false);
        assert.equal(lines.join("\n").includes(proof.toString("base64")), false);
        assert.equal(lines.every(line => !line.includes("\n")), true);
    });

    test("logs compression and invalid-submission failures before any gateway upload", async t => {
        const lines = capturePearlLogs(t);
        const proof = Buffer.from("private-compression-proof");
        t.mock.method(pearl, "packPearlGatewayProof", (_proof, callback) => callback(new Error("private-codec-error")));
        t.mock.method(pearl, "gatewayRequest", () => assert.fail("failed compression must not upload"));
        const context = { blockData: proof.toString("base64"),
            params: { plain_proof: proof, pearl_solution_id: PEARL_SOLUTION_ID },
            job: { id: "codec-candidate", targetDecimal: "1" } };
        const compressed = await submitGatewayProof(context);
        const invalid = await submitGatewayProof({ ...context, blockData: "not-base64" });
        assert.equal(compressed.status, 0);
        assert.equal(compressed.result.error.message, "Pearl proof compression failed");
        assert.equal(invalid.status, 0);
        assert.equal(invalid.result.error.message, "Invalid Pearl proof submission");
        assert.equal(lines.length, 2);
        for (const line of lines) assertPearlLogCorrelation(line, 123, "codec-candidate");
        assert.match(lines[0], /^PRL submit failed:.*stage=compression reason=compression-failed elapsed_ms=\d+$/);
        assert.match(lines[1], /^PRL submit failed:.*stage=submission reason=invalid-proof-submission elapsed_ms=\d+$/);
        assert.equal(lines.join("\n").includes("private-"), false);
    });

    test("gateway submissions preserve validated miner gzip without repacking raw verification data", async () => {
        const raw = Buffer.alloc(32 * 1024, 0x34);
        const packed = zlib.gzipSync(raw, { level: 9 });
        packed.writeUInt32LE(123, 4);
        const proof = pearl.decodePearlProof(packed.toString("base64"), "gzip", false, true);
        const originalGatewayRequest = pearl.gatewayRequest;
        const nativeGzip = zlib.gzip;
        let request;
        zlib.gzip = () => assert.fail("validated miner gzip must not be repacked");
        pearl.gatewayRequest = function captureRequest(method, params, callback) {
            request = { method, params };
            callback(null, { result: { status: "accepted", block_hash: "ab".repeat(32) } });
        };
        try {
            const response = await submitGatewayProof({
                blockData: raw.toString("base64"),
                params: { plain_proof: proof },
                job: { targetDecimal: "1", gatewayTarget: 1 }
            });
            assert.equal(response.status, 200);
            assert.equal(request.params.plain_proof, packed.toString("base64"));
            assert.equal(request.params.proof_encoding, "gzip");
            assert.equal(request.params.proof_raw_bytes, raw.length);
            assert.deepEqual(proof, raw);
            assert.equal(response.result.pearl_diagnostic.proof_sha256,
                crypto.createHash("sha256").update(raw).digest("hex"));
        } finally {
            pearl.gatewayRequest = originalGatewayRequest;
            zlib.gzip = nativeGzip;
        }
    });

    test("gateway packing failures never fall back to raw submissions", async () => {
        const originalGatewayRequest = pearl.gatewayRequest;
        const nativeGzip = zlib.gzip;
        const proof = Buffer.from("compression-failure-proof");
        let requests = 0;
        pearl.gatewayRequest = () => { requests += 1; };
        zlib.gzip = (_proof, _options, callback) => callback(new Error("native compression failed"));
        try {
            const response = await submitGatewayProof({
                blockData: proof.toString("base64"), params: { plain_proof: proof },
                job: { targetDecimal: "1" }
            });
            assert.equal(response.status, 0);
            assert.equal(response.result.error.message, "Pearl proof compression failed");
            const mismatch = await submitGatewayProof({
                blockData: proof.toString("base64"), params: { plain_proof: Buffer.from("different") },
                job: { targetDecimal: "1" }
            });
            assert.equal(mismatch.result.error.message, "Invalid Pearl proof submission");
            assert.equal(requests, 0);
        } finally {
            pearl.gatewayRequest = originalGatewayRequest;
            zlib.gzip = nativeGzip;
        }
    });

    test("packs raw gateway proofs and preserves bounded diagnostics without logging the proof", async () => {
        const proof = Buffer.from("winning-proof");
        const proofBase64 = proof.toString("base64");
        const originalGatewayRequest = pearl.gatewayRequest;
        let request;
        let response;
        pearl.gatewayRequest = function mockGatewayRequest(method, params, callback) {
            request = { method, params };
            callback(null, { error: { code: 17, message: "target mismatch", detail: "x".repeat(5000) } });
        };
        try {
            response = await submitGatewayProof({
                blockData: proofBase64,
                job: {
                    id: "pearl-job",
                    incomplete_header_bytes: Buffer.alloc(pearl.PEARL_HEADER_BYTES, 7).toString("base64"),
                    gatewayTarget: Number.MAX_VALUE,
                    targetDecimal: "123456789012345678901234567890",
                    cert_version: pearl.PEARL_CERT_VERSION
                },
                params: {
                    jackpot: "ab".repeat(32),
                    adjustment_factor: 7,
                    pearl_proof_id: "12".repeat(32),
                    plain_proof: proofBase64
                }
            });
        } finally {
            pearl.gatewayRequest = originalGatewayRequest;
        }
        assert.equal(request.method, "submitPlainProof");
        assert.equal(request.params.proof_encoding, "gzip");
        assert.equal(request.params.proof_raw_bytes, proof.length);
        assert.deepEqual(zlib.gunzipSync(Buffer.from(request.params.plain_proof, "base64")), proof);
        assert.equal(response.status, 200);
        const data = response.result.error.data;
        assert.equal(data.pearl.job_id, "pearl-job");
        assert.equal(data.pearl.proof_id, "12".repeat(32));
        assert.equal(data.pearl.proof_sha256, crypto.createHash("sha256").update(proof).digest("hex"));
        assert.equal(data.pearl.proof_base64_chars, proofBase64.length);
        assert.equal(data.pearl.target_decimal, "123456789012345678901234567890");
        assert.equal(data.pearl.target_is_safe_integer, false);
        assert.equal(data.pearl.jackpot, "ab".repeat(32));
        assert.equal(data.pearl.adjustment_factor, 7);
        assert.equal(data.gateway_response.truncated, true);
        assert.ok(data.gateway_response.bytes > 4096);
        assert.ok(data.gateway_response.preview.length <= 4096);
        const logged = JSON.stringify(response.result);
        assert.equal(logged.includes(proofBase64), false);
        assert.equal(logged.includes("plain_proof"), false);
    });

    test("adds Pearl diagnostics to accepted and transport-failed gateway results", async () => {
        const proof = Buffer.from("winning-proof").toString("base64");
        const originalGatewayRequest = pearl.gatewayRequest;
        const replies = [];
        const context = {
            blockData: proof,
            job: {
                id: "pearl-job",
                incomplete_header_bytes: Buffer.alloc(pearl.PEARL_HEADER_BYTES).toString("base64"),
                gatewayTarget: 123,
                targetDecimal: "123",
                cert_version: pearl.PEARL_CERT_VERSION
            },
            params: { pearl_proof_id: "34".repeat(32) },
            replyFn(result, status) { replies.push({ result, status }); }
        };
        try {
            pearl.gatewayRequest = function accepted(_method, _params, callback) {
                callback(null, { result: { status: "accepted", block_hash: "ab".repeat(32) } });
            };
            replies.push(await submitGatewayProof(context));
            const transportError = new Error("connection reset\nwith control text");
            transportError.code = "ECONNRESET";
            pearl.gatewayRequest = function failed(_method, _params, callback) { callback(transportError); };
            replies.push(await submitGatewayProof(context));
        } finally {
            pearl.gatewayRequest = originalGatewayRequest;
        }
        assert.equal(replies[0].status, 200);
        assert.equal(replies[0].result.pearl_diagnostic.proof_id, "34".repeat(32));
        assert.equal(replies[1].status, 0);
        assert.equal(replies[1].result.error.data.transport.code, "ECONNRESET");
        assert.equal(replies[1].result.error.data.pearl.proof_id, "34".repeat(32));
        assert.equal(JSON.stringify(replies).includes(proof), false);
    });
});
