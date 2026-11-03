"use strict";

const crypto = require("node:crypto");
const blockTemplate = require("node-blocktemplate");
const { blob, createProfile, pool, template } = require("./core/factories.js");
const pearl = require("./core/pearl.js");
const { formatLogEvent } = require("../common/logging.js");

const PEARL_GATEWAY_DIAGNOSTIC_MAX_BYTES = 4096;
const PEARL_GATEWAY_ERROR_MAX_CHARS = 512;
const pearlSubmissionIdentities = new WeakMap();
let nextCandidateClaimLog = 0;

/** @param {string} event @param {Record<string, unknown>} fields @param {boolean} [failed] */
function logPearlEvent(event, fields, failed = false) {
    const line = formatLogEvent(`PRL ${event}`, { pid: process.pid, ...fields });
    if (failed) console.error(line);
    else console.log(line);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** @param {unknown} body @returns {Record<string, unknown>|null} */
function rpcResultRecord(body) {
    if (!isRecord(body) || !isRecord(body["result"])) return null;
    return body["result"];
}

/** @param {unknown} body @returns {unknown} */
function rpcError(body) { return isRecord(body) ? body["error"] : undefined; }

/** @param {unknown} value @returns {number|null} */
function safeHeight(value) {
    const height = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(height) && height >= 0 ? height : null;
}

/** @param {unknown} value @returns {number|undefined} */
function optionalReward(value) {
    const reward = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(reward) && reward >= 0 ? reward : undefined;
}

/** @param {string} method @param {unknown[]} params @returns {{id: string, jsonrpc: string, method: string, params: unknown[]}} */
function daemonRequest(method, params) {
    return { id: "0", jsonrpc: "2.0", method, params };
}

/** @param {unknown} body @param {string} fallbackHash @returns {(Record<string, unknown> & {height: number, hash: string})|null} */
function normalizeDaemonHeader(body, fallbackHash) {
    const result = rpcResultRecord(body);
    if (!result) return null;
    const source = isRecord(result["header"]) ? result["header"] : result;
    const height = safeHeight(source["height"]);
    if (!source || height === null) return null;
    const hash = typeof source["hash"] === "string" && /^[0-9a-fA-F]{64}$/.test(source["hash"])
        ? source["hash"].toLowerCase()
        : fallbackHash;
    if (typeof hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(hash)) return null;
    /** @type {Record<string, unknown> & {height: number, hash: string}} */
    const normalized = { ...source, height, hash };
    const reward = optionalReward(source["reward"]);
    if (reward !== undefined) normalized["reward"] = reward;
    const confirmations = Number(source["confirmations"]);
    if (Number.isInteger(confirmations)) {
        normalized["depth"] = Math.max(0, confirmations);
        normalized["orphan_status"] = confirmations < 0;
    }
    return normalized;
}

/** @param {{target: bigint}} target @returns {string} */
function targetWireHex(target) { return target.target.toString(16).padStart(64, "0"); }

/** @param {unknown} value @returns {unknown} */
function boundedGatewayDiagnostic(value) {
    let serialized;
    try { serialized = JSON.stringify(value); } catch (_error) { return { unavailable: "not_json_serializable" }; }
    if (serialized === undefined) return { unavailable: typeof value };
    const bytes = Buffer.byteLength(serialized);
    if (bytes <= PEARL_GATEWAY_DIAGNOSTIC_MAX_BYTES) {
        try { return JSON.parse(serialized); } catch (_error) { return { unavailable: "invalid_json" }; }
    }
    return {
        truncated: true,
        bytes,
        preview: Buffer.from(serialized).subarray(0, PEARL_GATEWAY_DIAGNOSTIC_MAX_BYTES).toString("utf8")
    };
}

/** @param {unknown} error @returns {Record<string, unknown>} */
function gatewayErrorDiagnostic(error) {
    const record = error instanceof Error || isRecord(error) ? error : null;
    const message = record && typeof record.message === "string" ? record.message : String(error);
    const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;
    return {
        name: error instanceof Error ? error.name : typeof error,
        message: message.slice(0, PEARL_GATEWAY_ERROR_MAX_CHARS),
        ...(code === undefined ? {} : { code })
    };
}

/** @param {import("../../types/pool_profiles").PoolSubmitBlockContext} ctx @returns {Record<string, unknown>} */
function pearlSubmitDiagnostic(ctx) {
    const params = isRecord(ctx.params) ? ctx.params : {};
    const proof = typeof ctx.blockData === "string" ? ctx.blockData : "";
    const solutionId = typeof params["pearl_solution_id"] === "string" && /^[0-9a-f]{64}$/.test(params["pearl_solution_id"])
        ? params["pearl_solution_id"] : undefined;
    const proofId = typeof params["pearl_proof_id"] === "string" && /^[0-9a-f]{64}$/.test(params["pearl_proof_id"])
        ? params["pearl_proof_id"] : undefined;
    const jackpot = typeof params["jackpot"] === "string" && /^[0-9a-f]{64}$/.test(params["jackpot"])
        ? params["jackpot"] : undefined;
    const adjustmentFactor = typeof params["adjustment_factor"] === "number" && Number.isSafeInteger(params["adjustment_factor"])
        ? params["adjustment_factor"] : undefined;
    return {
        method: "submitPlainProof",
        ...(typeof ctx.job.id === "string" ? { job_id: ctx.job.id } : {}),
        ...(solutionId === undefined ? {} : { solution_id: solutionId }),
        ...(proofId === undefined ? {} : { proof_id: proofId }),
        proof_sha256: crypto.createHash("sha256").update(proof, "base64").digest("hex"),
        proof_base64_chars: proof.length,
        incomplete_header_bytes: ctx.job.incomplete_header_bytes,
        target: ctx.job.gatewayTarget,
        target_is_safe_integer: Number.isSafeInteger(ctx.job.gatewayTarget),
        target_decimal: ctx.job.targetDecimal,
        cert_version: ctx.job.cert_version,
        ...(jackpot === undefined ? {} : { jackpot }),
        ...(adjustmentFactor === undefined ? {} : { adjustment_factor: adjustmentFactor })
    };
}

/** @typedef {{header: Buffer, target: bigint, targetDecimal: string, targetHex: string, prevHash: string, difficulty: number, compact: number}} ParsedPearlHeader */
/** @typedef {Record<string, unknown> & {height: number, hash: string}} NormalizedPearlHeader */

/** @typedef {{worker_coinbase_bytes: string, worker_coinbase_offset: number, worker_merkle_branch: string}} PearlWorkerRecipe */
/** @param {(error: unknown, info?: {header: string, parsed: ParsedPearlHeader, recipe: PearlWorkerRecipe, reward?: number}) => void} callback */
function requestMiningJob(callback) {
    pearl.gatewayRequest("getMiningInfo", {}, function onMiningInfo(error, body) {
        if (error) return callback(error);
        const result = pearl.gatewayResult(body);
        if (!isRecord(result) || result["cert_version"] !== pearl.PEARL_CERT_VERSION ||
            typeof result["incomplete_header_bytes"] !== "string") {
            return callback(new Error("invalid Pearl mining info"));
        }
        const header = result["incomplete_header_bytes"];
        const parsed = pearl.parseMiningHeader(header);
        if (!parsed) return callback(new Error("invalid Pearl mining header"));
        if (result["target_decimal"] !== undefined && result["target_decimal"] !== parsed.targetDecimal) {
            return callback(new Error("Pearl target does not match header"));
        }
        const decoded = pearl.decodeWorkerRecipe(result);
        if (!decoded) return callback(new Error("Pearl worker recipe is missing or invalid"));
        let derived;
        try {
            derived = blockTemplate.derivePearlWorkerHeader(parsed.header, decoded.coinbase, decoded.offset, decoded.branch, 0);
        } catch (_error) {
            return callback(new Error("Pearl worker recipe could not be derived"));
        }
        if (!derived.equals(parsed.header)) return callback(new Error("Pearl worker recipe does not match header"));
        const recipe = /** @type {PearlWorkerRecipe} */ ({
            worker_coinbase_bytes: result["worker_coinbase_bytes"],
            worker_coinbase_offset: decoded.offset,
            worker_merkle_branch: result["worker_merkle_branch"]
        });
        const reward = optionalReward(result["expected_reward"]);
        return callback(null, { header, parsed, recipe, ...(reward === undefined ? {} : { reward }) });
    }, { timeoutMs: pearl.PEARL_GATEWAY_TIMEOUT_MS });
}

/** @param {{runtime: import("../../types/coin_profiles").ProfileRuntime, port: number, callback: import("../../types/coin_profiles").RpcCallback, noErrorReport?: boolean, profile: import("../../types/coin_profiles").CoinProfile}} ctx @param {(error: unknown, info?: {header: string, parsed: ParsedPearlHeader, previous: NormalizedPearlHeader, recipe: PearlWorkerRecipe, reward?: number}) => void} callback */
function getMiningInfo(ctx, callback) {
    requestMiningJob(function onMiningJob(error, info) {
        if (error || !info) return callback(error || new Error("invalid Pearl mining info"));
        const { header, parsed, recipe, reward } = info;
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", daemonRequest("getblockheader", [parsed.prevHash, true]), function onPreviousHeader(reply) {
            /** @type {NormalizedPearlHeader|null} */
            const previous = normalizeDaemonHeader(reply, parsed.prevHash);
            if (!previous) return callback(rpcError(reply) || new Error("invalid Pearl previous header"));
            // pearld reports difficulty relative to its compact consensus PoW limit. Pool
            // accounting instead defines one PRL difficulty as 1,000,000 rank-128 MACs, so
            // derive the network difficulty from the exact template target in those units.
            previous["difficulty"] = parsed.difficulty;
            if (reward !== undefined) {
                previous["reward"] = reward;
                previous["expected_reward"] = reward;
            }
            return callback(null, { header, parsed, previous, recipe, ...(reward === undefined ? {} : { reward }) });
        }, ctx.noErrorReport);
    });
}

/** @param {import("../../types/coin_profiles").RpcSettings} config */
function createPearlRpc(config) {
    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        getMiningInfo(ctx, function onMiningInfo(error, info) {
            if (error || !info) return ctx.callback(error || true, null);
            return ctx.callback(null, info.previous);
        });
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        getMiningInfo(ctx, function onMiningInfo(error, info) {
            if (error || !info) return ctx.callback(null, error || "invalid Pearl mining info");
            const parsed = info.parsed;
            const templateRecord = {
                hash: info.header,
                header: info.header,
                cert_version: pearl.PEARL_CERT_VERSION,
                target: parsed.targetDecimal,
                pearl_target: parsed.targetDecimal,
                target_hex: parsed.targetHex,
                target_compact: parsed.compact,
                incomplete_header_bytes: info.header,
                ...info.recipe,
                gateway_target: Number(parsed.targetDecimal),
                difficulty: parsed.difficulty,
                height: info.previous.height + 1,
                ...(info.reward === undefined ? {} : { expected_reward: info.reward })
            };
            return ctx.callback(templateRecord, null);
        });
    };

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        const height = safeHeight(ctx.blockId);
        if (height === null) return ctx.callback(true, { error: "invalid Pearl block height" });
        return ctx.runtime.support.rpcPortDaemon2(ctx.port, "", daemonRequest("getblockhash", [height]), function onHash(body) {
            const hashResult = isRecord(body) ? body["result"] : undefined;
            if (typeof hashResult !== "string" || !/^[0-9a-fA-F]{64}$/.test(hashResult)) return ctx.callback(true, body);
            return ctx.runtime.support.rpcPortDaemon2(ctx.port, "", daemonRequest("getblockheader", [hashResult, true]), function onHeader(headerBody) {
                const header = normalizeDaemonHeader(headerBody, hashResult);
                if (!header) return ctx.callback(true, headerBody);
                return ctx.callback(null, header);
            }, ctx.noErrorReport);
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        const hash = typeof ctx.blockHash === "string" && /^[0-9a-fA-F]{64}$/.test(ctx.blockHash)
            ? ctx.blockHash.toLowerCase()
            : null;
        if (!hash) return ctx.callback(true, { error: "invalid Pearl block hash" });
        return ctx.runtime.support.rpcPortDaemon2(ctx.port, "", daemonRequest("getblockheader", [hash, true]), function onHeader(body) {
            const header = normalizeDaemonHeader(body, hash);
            if (!header) return ctx.callback(true, body);
            if (ctx.isOurBlock && header["orphan_status"] !== true) {
                return ctx.runtime.support.rpcPortDaemon2(ctx.port, "", daemonRequest("getblock", [hash, 2]), function onBlock(blockBody) {
                    const block = rpcResultRecord(blockBody);
                    const transactions = block && (block["rawtx"] || block["tx"]);
                    const coinbase = Array.isArray(transactions) ? transactions[0] : null;
                    const inputs = isRecord(coinbase) ? coinbase["vin"] : null;
                    const outputs = isRecord(coinbase) ? coinbase["vout"] : null;
                    const address = ctx.runtime.getPoolAddress(ctx.profile);
                    if (!block || block["hash"] !== hash || !address || !Array.isArray(inputs) ||
                        !isRecord(inputs[0]) || typeof inputs[0]["coinbase"] !== "string" || !Array.isArray(outputs)) {
                        return ctx.callback(true, { ...header, error: "invalid Pearl coinbase reward" });
                    }
                    let reward = 0;
                    for (const output of outputs) {
                        if (!isRecord(output) || typeof output["value"] !== "number" || !Number.isFinite(output["value"]) || output["value"] < 0) {
                            return ctx.callback(true, { ...header, error: "invalid Pearl coinbase output" });
                        }
                        const script = output["scriptPubKey"];
                        if (isRecord(script) && (script["address"] === address ||
                            (Array.isArray(script["addresses"]) && script["addresses"].includes(address)))) {
                            reward += Math.round(output["value"] * 100000000);
                        }
                    }
                    if (!Number.isSafeInteger(reward) || reward <= 0) return ctx.callback(true, { ...header, error: "Pearl coinbase does not pay pool address" });
                    return ctx.callback(null, { ...header, reward });
                }, ctx.noErrorReport);
            }
            return ctx.callback(null, header);
        }, ctx.noErrorReport);
    };
    return config;
}

/** @param {import("../../types/pool_profiles").PoolAuthorizeAlgoContext} _ctx */
function authorizeAlgoState(_ctx) {
    return { algos: [pearl.PEARL_ALGO], algosPerf: { [pearl.PEARL_ALGO]: 1 }, algoMinTime: 60 };
}

/** @param {import("../../types/pool_profiles").PoolSubmitParams} params @returns {boolean} */
function hasValidPearlClaim(params) {
    const hasJackpot = params.jackpot !== undefined;
    const hasFactor = params.adjustment_factor !== undefined;
    if (!hasJackpot && !hasFactor) return true;
    return hasJackpot && hasFactor && typeof params.jackpot === "string" && /^[0-9a-fA-F]{64}$/.test(params.jackpot) &&
        typeof params.adjustment_factor === "number" && Number.isInteger(params.adjustment_factor) &&
        params.adjustment_factor > 0 && params.adjustment_factor <= 0xffffffff;
}

/** @param {{params: import("../../types/pool_profiles").PoolSubmitParams}} ctx @returns {boolean} */
function validateNamedProof(ctx) {
    if (!isRecord(ctx.params)) return false;
    return typeof ctx.params.job_id === "string" || typeof ctx.params.job_id === "number"
        ? typeof ctx.params.plain_proof === "string" && ctx.params.plain_proof.length <= pearl.PEARL_MAX_PROOF_BASE64_CHARS
            && pearl.isCanonicalBase64(ctx.params.plain_proof)
            && (ctx.params.proof_encoding === undefined || ctx.params.proof_encoding === "none" ||
                ctx.params.proof_encoding === "gzip")
            && (ctx.params["cert_version"] === undefined ||
                ctx.params["cert_version"] === pearl.PEARL_CERT_VERSION)
            && hasValidPearlClaim(ctx.params)
        : false;
}

/** @typedef {{valid: false}|{valid: true, solution_id: string, config: Record<string, unknown> & {adjustment_factor: number}, headerHex: string}} PearlSolutionIdentity */
/** @typedef {{pearlSolutionId?: (headerHex: string, proof: Buffer) => unknown, pearlSolutionIdFromData?: (solutionData: Buffer) => string}} PearlIdentityCoinFuncs */

/** @param {import("../../types/pool_profiles").PoolJob|undefined} job @param {string|undefined} fallbackHeader @returns {string|null} */
function pearlJobHeaderHex(job, fallbackHeader) {
    const headerBase64 = job && typeof job.incomplete_header_bytes === "string"
        ? job.incomplete_header_bytes
        : fallbackHeader;
    const header = pearl.decodePearlHeader(headerBase64);
    return header ? header.toString("hex") : null;
}

/** @param {PearlIdentityCoinFuncs|undefined} coinFuncs @param {import("../../types/pool_profiles").PoolJob|undefined} job @param {Buffer} proof @param {string|undefined} fallbackHeader @returns {PearlSolutionIdentity} */
function computePearlSolutionIdentity(coinFuncs, job, proof, fallbackHeader) {
    const headerHex = pearlJobHeaderHex(job, fallbackHeader);
    if (!headerHex || !coinFuncs || typeof coinFuncs.pearlSolutionId !== "function") return { valid: false };
    try {
        const parsed = pearl.parsePearlSolutionIdResult(coinFuncs.pearlSolutionId(headerHex, proof));
        if (!parsed || !parsed.valid) return { valid: false };
        return { valid: true, solution_id: parsed.solution_id, config: parsed.config, headerHex };
    } catch (_error) {
        return { valid: false };
    }
}

/** @param {{params: import("../../types/pool_profiles").PoolSubmitParams, coinFuncs?: PearlIdentityCoinFuncs, job?: import("../../types/pool_profiles").PoolJob, fallbackHeader?: string}} ctx @returns {PearlSolutionIdentity} */
function getPearlSolutionIdentity(ctx) {
    if (isRecord(ctx.params)) {
        const cached = pearlSubmissionIdentities.get(ctx.params);
        if (cached) return cached;
    }
    const decoded = isRecord(ctx.params)
        ? (Buffer.isBuffer(ctx.params.plain_proof)
            ? ctx.params.plain_proof
            : pearl.decodePearlProof(ctx.params.plain_proof))
        : null;
    /** @type {PearlSolutionIdentity} */
    const identity = decoded
        ? computePearlSolutionIdentity(ctx.coinFuncs, ctx.job, decoded, ctx.fallbackHeader)
        : { valid: false };
    if (isRecord(ctx.params)) pearlSubmissionIdentities.set(ctx.params, identity);
    return identity;
}

/** @param {{params: import("../../types/pool_profiles").PoolSubmitParams, wireParams: unknown, miner?: import("../../types/pool_profiles").PoolMinerView, coinFuncs?: PearlIdentityCoinFuncs, job?: import("../../types/pool_profiles").PoolJob}} ctx @returns {boolean} */
function normalizeNamedSubmitParams(ctx) {
    if (isRecord(ctx.params)) pearlSubmissionIdentities.delete(ctx.params);
    if (!isRecord(ctx.wireParams) || !validateNamedProof(ctx)) return false;
    if (typeof ctx.params.job_id === "number") ctx.params.job_id = String(ctx.params.job_id);
    const decoded = pearl.decodePearlProof(ctx.params.plain_proof, ctx.params.proof_encoding,
        ctx.miner?.pearlProofGzip === true, true);
    if (!decoded) return false;
    ctx.params.plain_proof = decoded;
    if (ctx.job) {
        pearlSubmissionIdentities.set(
            ctx.params,
            computePearlSolutionIdentity(ctx.coinFuncs, ctx.job, decoded, undefined)
        );
    }
    if (typeof ctx.params.jackpot === "string") ctx.params.jackpot = ctx.params.jackpot.toLowerCase();
    for (const field of Object.keys(ctx.params)) {
        if (!["job_id", "plain_proof", "jackpot", "adjustment_factor"].includes(field)) delete ctx.params[field];
    }
    return true;
}

/** @param {{params: import("../../types/pool_profiles").PoolSubmitParams}} ctx @returns {boolean} */
function parseNamedSubmitParams(ctx) {
    return isRecord(ctx.params) && pearlSubmissionIdentities.has(ctx.params)
        ? true
        : validateNamedProof(ctx);
}

/** @param {import("../../types/pool_profiles").PoolSubmissionKeyContext} ctx @returns {string} */
function buildPearlSubmissionKey(ctx) {
    const identity = getPearlSolutionIdentity(ctx);
    return identity.valid ? identity.solution_id : "";
}

/** @param {{params: import("../../types/pool_profiles").PoolSubmitParams}} ctx @returns {Record<string, unknown>} */
function sanitizePearlSubmitParams(ctx) {
    return { job_id: ctx.params.job_id };
}

/** @param {import("../../types/pool_profiles").PoolSubmitContext} ctx @returns {boolean} */
function validatePearlSubmit(ctx) {
    if (!isRecord(ctx.params)) return false;
    const cached = pearlSubmissionIdentities.get(ctx.params);
    if (cached) return cached.valid;
    if (!validateNamedProof(ctx)) return false;
    return getPearlSolutionIdentity({ params: ctx.params, coinFuncs: ctx.coinFuncs, job: ctx.job }).valid;
}

/** @param {import("../../types/pool_profiles").BuildJobContext} ctx @returns {import("../../types/pool_profiles").PoolJobPayload} */
function buildPearlJobPayload(ctx) {
    const target = pearl.targetForDifficulty(ctx.coinDiff);
    if (!target) throw new Error("invalid Pearl share difficulty");
    const incompleteHeader = ctx.blockTemplate.incomplete_header_bytes || ctx.blockTemplate.header;
    const parsedHeader = typeof incompleteHeader === "string" ? pearl.parseMiningHeader(incompleteHeader) : null;
    if (typeof incompleteHeader !== "string" || !parsedHeader ||
        ctx.blockTemplate.cert_version !== pearl.PEARL_CERT_VERSION) {
        throw new Error("invalid Pearl block template");
    }
    const targetWire = targetWireHex(target);
    ctx.newJob.target = targetWire;
    ctx.newJob.targetHex = target.targetHex;
    ctx.newJob.targetDecimal = target.targetDecimal;
    ctx.newJob.gatewayTarget = Number(target.targetDecimal);
    ctx.newJob.incomplete_header_bytes = incompleteHeader;
    ctx.newJob.cert_version = ctx.blockTemplate.cert_version;
    return {
        header: parsedHeader.header.toString("hex"),
        job_id: ctx.newJob.id,
        target: targetWire,
        cert_version: ctx.blockTemplate.cert_version,
        proof_encodings: ["none", "gzip"]
    };
}

/** @param {import("../../types/pool_profiles").PushJobContext} ctx */
function pushPearlJob(ctx) {
    ctx.miner.pushMessage({ method: "mining.notify", params: ctx.job, id: null });
}

/** @param {import("../../types/pool_profiles").PoolLoginContext} ctx */
function sendPearlLoginResult(ctx) {
    ctx.sendReply(null, true);
    ctx.miner.sendBestCoinJob();
}

/** @param {Omit<import("../../types/pool_profiles").PoolLoginContext, "jobParams">} ctx */
function sendPearlAuthorizeResult(ctx) {
    ctx.miner.pearlProofGzip = true;
    ctx.sendReply(null, true, { type: "v2" });
    ctx.miner.sendBestCoinJob();
}

/** @param {import("../../types/pool_profiles").PoolSpecialShareContext} ctx @returns {boolean} */
function verifyPearlShare(ctx) {
    const header = typeof ctx.blockTemplate.header === "string" ? ctx.blockTemplate.header : "";
    const parsed = pearl.parseMiningHeader(header);
    const proof = isRecord(ctx.params)
        ? (Buffer.isBuffer(ctx.params.plain_proof) ? ctx.params.plain_proof : null)
        : null;
    const targetHex = ctx.job.targetHex;
    if (!parsed || !Buffer.isBuffer(proof) || proof.length === 0 || proof.length > pearl.PEARL_MAX_PROOF_BYTES ||
        typeof targetHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(targetHex)) {
        return ctx.processShareCB(ctx.invalidShare(ctx.miner)), true;
    }
    const claimedJackpot = typeof ctx.params.jackpot === "string" ? ctx.params.jackpot.toLowerCase() : null;
    const claimedFactor = typeof ctx.params.adjustment_factor === "number" ? ctx.params.adjustment_factor : null;
    const hasClaimFields = ctx.params.jackpot !== undefined || ctx.params.adjustment_factor !== undefined;
    if (hasClaimFields && !hasValidPearlClaim(ctx.params)) {
        return ctx.processShareCB(ctx.invalidShare(ctx.miner)), true;
    }
    const identity = getPearlSolutionIdentity({
        params: ctx.params,
        coinFuncs: ctx.coinFuncs,
        job: ctx.job,
        fallbackHeader: header
    });
    if (!identity.valid || identity.headerHex !== parsed.header.toString("hex")) {
        return ctx.processShareCB(ctx.invalidShare(ctx.miner)), true;
    }
    const hasClaim = claimedJackpot !== null && claimedFactor !== null;
    const candidateFields = { height: ctx.blockTemplate.height, job: ctx.job.id, solution: identity.solution_id };
    const claimedBlock = hasClaim && pearl.isPearlNetworkCandidate(claimedJackpot, ctx.blockTemplate.target, claimedFactor);
    // Claims are untrusted: cap their log volume without suppressing verified candidates.
    const logClaim = claimedBlock && Date.now() >= nextCandidateClaimLog;
    if (logClaim) {
        nextCandidateClaimLog = Date.now() + 10000;
        logPearlEvent("candidate claimed", {
            ...candidateFields, jackpot: claimedJackpot, network_target: ctx.blockTemplate.target, adjustment_factor: claimedFactor
        });
    }
    /** @param {string} reason @param {boolean} [invalid] */
    function rejectCandidate(reason, invalid = false) {
        if (logClaim) logPearlEvent("candidate rejected", { ...candidateFields, stage: "verification", reason }, true);
        return ctx.processShareCB(invalid ? ctx.invalidShare(ctx.miner) : null);
    }
    if (hasClaim) {
        if (!pearl.isPearlTargetCandidate(claimedJackpot, ctx.job.targetDecimal, claimedFactor)) {
            return rejectCandidate("outside-share-target", true), true;
        }
        if (identity.config.adjustment_factor !== claimedFactor) {
            return rejectCandidate("claim-factor-mismatch", true), true;
        }
        if (!claimedBlock && typeof ctx.tryTrustedShare === "function" && ctx.tryTrustedShare(function acceptTrustedPearlShare() {
            ctx.verifyShareCB(ctx.job.difficulty, null, null, true, false, false);
        })) return true;
    }
    if (typeof ctx.startAsyncVerification === "function") ctx.startAsyncVerification();
    if (typeof ctx.coinFuncs.verifyPearlAsync !== "function") return rejectCandidate("verifier-unavailable"), true;
    let verificationCompleted = false;
    ctx.coinFuncs.verifyPearlAsync(identity.headerHex, proof, targetHex, ctx.miner.payout, function onVerified(result, errorKind) {
        if (verificationCompleted) return;
        verificationCompleted = true;
        if (errorKind || result === null || typeof result === "undefined") return rejectCandidate("verifier-unavailable");
        const verified = pearl.parsePearlVerifierResult(result);
        if (!verified) return rejectCandidate("invalid-verifier-response");
        if (!verified.valid) return rejectCandidate("invalid-proof", true);
        if (typeof ctx.coinFuncs.pearlSolutionIdFromData !== "function") return rejectCandidate("solution-id-unavailable");
        const verifiedSolutionId = ctx.coinFuncs.pearlSolutionIdFromData(Buffer.from(verified.solution_data, "hex"));
        if (!/^[0-9a-f]{64}$/.test(verifiedSolutionId)) return rejectCandidate("invalid-solution-id");
        if (verifiedSolutionId !== identity.solution_id || verified.config.adjustment_factor !== identity.config.adjustment_factor) {
            return rejectCandidate("verified-identity-mismatch", true);
        }
        if (!verified.candidate) return rejectCandidate("outside-share-target", true);
        if (hasClaim && (verified.jackpot !== claimedJackpot || verified.config.adjustment_factor !== claimedFactor)) {
            return rejectCandidate("claim-result-mismatch", true);
        }
        ctx.params["pearl_solution_id"] = verifiedSolutionId;
        if (verified.proof_id) ctx.params["pearl_proof_id"] = verified.proof_id;
        const isCandidate = pearl.isPearlNetworkCandidate(
            verified.jackpot, ctx.blockTemplate.target, verified.config.adjustment_factor
        );
        if (typeof ctx.addWalletTrust === "function") ctx.addWalletTrust();
        if (!isCandidate) {
            if (logClaim) logPearlEvent("candidate rejected", { ...candidateFields, stage: "verification", reason: "network-target-not-met" }, true);
            return ctx.verifyShareCB(ctx.job.difficulty, null, null, false, false, false);
        }
        logPearlEvent("candidate verified", {
            ...candidateFields, jackpot: verified.jackpot, network_target: ctx.blockTemplate.target,
            adjustment_factor: verified.config.adjustment_factor, network_target_met: true
        });
        return ctx.verifyShareCB(ctx.job.difficulty, null, proof.toString("base64"), false, true, true);
    });
    return true;
}

/** @param {unknown} rpcResult @returns {(Record<string, unknown> & {block_hash: string})|null} */
function acceptedPearlResult(rpcResult) {
    const result = isRecord(rpcResult) && isRecord(rpcResult["result"]) ? rpcResult["result"] : null;
    if (!result || result["status"] !== "accepted" || typeof result["block_hash"] !== "string" || !/^[0-9a-fA-F]{64}$/.test(result["block_hash"])) return null;
    return /** @type {Record<string, unknown> & {block_hash: string}} */ (result);
}

/** @param {import("../../types/pool_profiles").PoolBlockAcceptanceContext} ctx @returns {boolean} */
function acceptPearlBlock(ctx) {
    return acceptedPearlResult(ctx.rpcResult) !== null;
}

/** @param {import("../../types/pool_profiles").PoolBlockHashContext} ctx @param {(blockHash: string) => void} callback */
function resolvePearlBlockHash(ctx, callback) {
    const result = acceptedPearlResult(ctx.rpcResult);
    callback(result ? result.block_hash.toLowerCase() : "0".repeat(64));
}

/** @this {import("../../types/pool_profiles").PoolProfileSettings} @param {import("../../types/pool_profiles").PoolSubmitBlockContext} ctx */
function submitPearlBlock(ctx) {
    const started = Date.now();
    const params = isRecord(ctx.params) ? ctx.params : {};
    const fields = {
        height: ctx.blockTemplate.height, job: ctx.job.id,
        solution: typeof params["pearl_solution_id"] === "string" && /^[0-9a-f]{64}$/.test(params["pearl_solution_id"])
            ? params["pearl_solution_id"] : undefined
    };
    /** @param {string} stage @param {string} reason */
    function failed(stage, reason) {
        logPearlEvent("submit failed", { ...fields, stage, reason, elapsed_ms: Date.now() - started }, true);
    }
    if (typeof ctx.blockData !== "string" || typeof ctx.job.targetDecimal !== "string") {
        failed("submission", "invalid-proof-submission");
        return ctx.replyFn({ error: { code: -1, message: "Invalid Pearl proof submission" } }, 0);
    }
    const retained = Buffer.isBuffer(params["plain_proof"]) ? params["plain_proof"] : null;
    const proof = retained || pearl.decodePearlProof(ctx.blockData);
    if (!proof || proof.length === 0 || proof.length > pearl.PEARL_MAX_PROOF_BYTES ||
        (retained && retained.toString("base64") !== ctx.blockData)) {
        failed("submission", "invalid-proof-submission");
        return ctx.replyFn({ error: { code: -1, message: "Invalid Pearl proof submission" } }, 0);
    }
    const diagnostic = pearlSubmitDiagnostic(ctx);
    pearl.packPearlGatewayProof(proof, function onPacked(packError, packed) {
        if (packError || !packed) {
            failed("compression", "compression-failed");
            return ctx.replyFn({ error: { code: -1, message: "Pearl proof compression failed" } }, 0);
        }
        logPearlEvent("submit started", { ...fields, encoding: "gzip", raw_bytes: proof.length, packed_bytes: packed.length });
        pearl.gatewayRequest("submitPlainProof", {
            plain_proof: packed.toString("base64"),
            proof_encoding: "gzip",
            proof_raw_bytes: proof.length,
            mining_job: {
                incomplete_header_bytes: ctx.job.incomplete_header_bytes,
                target: ctx.job.gatewayTarget,
                target_decimal: ctx.job.targetDecimal,
                cert_version: ctx.job.cert_version,
                worker_id: global.coinFuncs.uniqueWorkerId
            }
        }, function onReply(error, reply) {
            if (error) {
                failed("gateway", error.message === "Pearl gateway timeout" ? "timeout" : "request-failed");
                return ctx.replyFn({
                    error: {
                        code: -1,
                        message: "Pearl gateway request failed",
                        data: { pearl: diagnostic, transport: gatewayErrorDiagnostic(error) }
                    }
                }, 0);
            }
            const accepted = acceptedPearlResult(reply);
            if (!accepted) {
                failed("gateway", "proof-not-accepted");
                return ctx.replyFn({
                    error: {
                        code: -1,
                        message: "Pearl gateway did not accept the proof",
                        data: { pearl: diagnostic, gateway_response: boundedGatewayDiagnostic(reply) }
                    }
                }, 200);
            }
            logPearlEvent("submit accepted", {
                ...fields, block: accepted.block_hash.toLowerCase(), elapsed_ms: Date.now() - started
            });
            return ctx.replyFn({ ...(isRecord(reply) ? reply : {}), pearl_diagnostic: diagnostic }, 200);
        }, { timeoutMs: pearl.PEARL_GATEWAY_SUBMIT_TIMEOUT_MS });
    });
}

const pearlPool = pool.standard({
    minDifficulty: "config",
    hashesPerDifficulty: pearl.PEARL_HASHES_PER_DIFFICULTY,
    disableProxyNonce: true,
    sharedTemplateSubmissions: true,
    authorizeAlgoState,
    sendLoginResult: sendPearlLoginResult,
    sendNamedLoginResult: sendPearlAuthorizeResult,
    normalizeNamedAuthorizeParams: function normalizeNamedAuthorize(ctx) {
        const params = ctx.params;
        if (!isRecord(params) || typeof params["wallet"] !== "string" || !params["wallet"] || typeof params["worker"] !== "string") return false;
        if (params["pass"] === undefined) {
            if (typeof params["agent"] !== "string" || typeof params["type"] !== "string") return false;
            params["pass"] = "x";
        } else if (typeof params["pass"] !== "string") return false;
        params["login"] = params["wallet"];
        params["rigid"] = params["worker"];
        delete params["type"];
        const state = authorizeAlgoState({ coinFuncs: global.coinFuncs, port: ctx.port, profile: ctx.profile });
        params["algo"] = state.algos;
        params["algo-perf"] = state.algosPerf;
        params["algo-min-time"] = state.algoMinTime;
        return true;
    },
    normalizeNamedSubmitParams,
    parseMiningSubmitParams: parseNamedSubmitParams,
    validateSubmitParams: validatePearlSubmit,
    submissionKey: buildPearlSubmissionKey,
    sanitizeSubmitParams: sanitizePearlSubmitParams,
    sensitiveSubmitData: true,
    getTrustedQueueRetainedBytes(params) {
        const proof = params && params.plain_proof;
        return Buffer.isBuffer(proof) ? proof.length + (pearl.getPearlProofGzip(proof)?.length || 0)
            : typeof proof === "string" ? proof.length : 0;
    },
    verifySpecialShare: verifyPearlShare,
    acceptSubmittedBlock: acceptPearlBlock,
    resolveSubmittedBlockHash: resolvePearlBlockHash,
    submitBlockRpc: submitPearlBlock,
    submitSuccess: "status",
    buildJobPayload: buildPearlJobPayload,
    buildProxyJobPayload: buildPearlJobPayload,
    pushJob: pushPearlJob
});

module.exports = createProfile({
    port: pearl.PEARL_PORT,
    coin: "PRL",
    displayCoin: "PRL",
    blobType: pearl.PEARL_BLOB_TYPE,
    algo: pearl.PEARL_ALGO,
    minerAlgoAliases: { [pearl.PEARL_ALGO]: ["pearl", "pearlhash"] },
    perf: { aliases: [pearl.PEARL_ALGO, "pearl"] },
    blobTypeName: "pearl",
    blob: blob.identity(),
    pool: pearlPool,
    template: template.hashOnly(),
    rpc: createPearlRpc({ unlockConfirmationDepth: 100 })
});
