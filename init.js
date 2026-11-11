"use strict";
require("./lib/common/ca_trust.js")();
const mysql = require("promise-mysql");
const fs = require("fs");
// Node exports Cluster directly to CommonJS; @types/node describes its ESM default.
const cluster = /** @type {import("node:cluster").Cluster} */ (/** @type {unknown} */ (require("node:cluster")));
const argv = require('./parse_args')(process.argv.slice(2));
const config = fs.readFileSync("./config.json", "utf8");
const coinConfig = fs.readFileSync("./coinConfig.json", "utf8");
const protobuf = require('protocol-buffers');
const adaptWorkCodecs = require("./lib/common/work_codec.js");
const resolveCoinConfig = require("./resolve_coin_config.js");
const path = require('path');
const applyConfigRows = require("./lib/common/config_rows.js");
const isPrimaryProcess = require("./lib/common/is_primary_process.js");
const { getInitializedLocalDatabase, getRemoteDatabase } = require("./lib/common/database.js");

const moduleOption = argv["module"];
const toolOption = argv["tool"];
const moduleName = typeof moduleOption === "string" ? moduleOption : null;
const toolName = typeof toolOption === "string" ? toolOption : null;

const STARTUP_FAILURE_RESTART_DELAY_MS = 60 * 1000;

global.support = require("./lib/common/support.js")();
const startupConfig = JSON.parse(config);
const resolvedCoinConfig = resolveCoinConfig(startupConfig, JSON.parse(coinConfig));
global.config = startupConfig;
global.mysql = mysql.createPool(global.config.mysql);
global.protos = adaptWorkCodecs(protobuf(fs.readFileSync('./lib/common/data.proto')));
global.argv = argv;
let coinInc;
/** @type {unknown} */
let activeModule = null;
const { formatLogEvent } = require("./lib/common/logging.js");

/** @param {string} label @param {Record<string, unknown>} fields */
function logEvent(label, fields) { console.log(formatLogEvent(label, fields)); }

/** @param {string} kind @param {string} name */
function logStartup(kind, name) {
    console.log(`=== STARTING ${  kind.toUpperCase()  }: ${  name  } ===`);
}

/** @param {import("cluster").Cluster} clusterApi */
function hasClusterWorkers(clusterApi) {
    const workers = clusterApi.workers;
    return workers ? Object.values(workers).some(Boolean) : false;
}

/** @param {unknown} error */
function shutdownErrorMessage(error) { return error instanceof Error ? error.message : String(error); }

/** @returns {Promise<unknown>} */
function stopActiveModule() {
    if (!activeModule || typeof activeModule !== "object" || !("stop" in activeModule) || typeof activeModule.stop !== "function") return Promise.resolve();
    return Promise.resolve(activeModule.stop());
}

/** @returns {Promise<void>} */
function disconnectCluster() {
    return new Promise(function onDisconnect(resolve) {
        if (!isPrimaryProcess(cluster) || !hasClusterWorkers(cluster) || typeof cluster.disconnect !== "function") {
            resolve();
            return;
        }
        try {
            cluster.disconnect(resolve);
        } catch (_error) {
            resolve();
        }
    });
}

function closeMysql() {
    if (!global.mysql || typeof global.mysql.end !== "function") return Promise.resolve();
    return Promise.resolve(global.mysql.end());
}

/** @returns {Promise<void>} */
function syncDatabaseEnv() {
    return new Promise(function onSync(resolve) {
        const database = global.database;
        const env = database && database.role === "local" ? database.env : null;
        if (!env || typeof env.sync !== "function") {
            resolve();
            return;
        }
        try {
            env.sync(resolve);
        } catch (_error) {
            resolve();
        }
    });
}

let databaseEnvClosed = false;
function closeDatabaseEnv() {
    if (databaseEnvClosed) return;
    const database = global.database;
    if (database && database.role === "remote") {
        databaseEnvClosed = true;
        try {
            database.close();
        } catch (error) {
            console.error(`Remote database close failed: ${  shutdownErrorMessage(error)}`);
        }
        return;
    }
    const env = database && database.role === "local" ? database.env : null;
    if (!env || typeof env.close !== "function") return;
    // Mark closed before calling close() so a later exit handler never double-closes (which throws).
    databaseEnvClosed = true;
    try {
        env.close();
    } catch (error) {
        console.error(`LMDB close failed: ${  shutdownErrorMessage(error)}`);
    }
}

/** @param {string} name */
function installGracefulShutdown(name) {
    let shuttingDown = false;
    const kind = (moduleName !== null) ? 'module' : 'tool';

    /** @param {string} signal @returns {Promise<void>} */
    async function handleSignal(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        logEvent("Shutdown", { kind, name, signal, status: "stopping" });

        /** @param {string} label @param {() => unknown} fn @returns {Promise<void>} */
        async function runStep(label, fn) {
            try {
                await fn();
            } catch (error) {
                console.error(`${label  } failed: ${  shutdownErrorMessage(error)}`);
            }
        }

        await runStep("Module shutdown", stopActiveModule);
        await runStep("Cluster disconnect", disconnectCluster);
        await runStep("MySQL shutdown", closeMysql);
        await runStep("LMDB sync", syncDatabaseEnv);
        await runStep("LMDB close", closeDatabaseEnv);
        logEvent("Shutdown", { kind, name, signal, status: "stopped" });
        process.exit(0);
    }

    /** @param {string} signal */
    function triggerShutdown(signal) {
        handleSignal(signal).catch(function onUnhandled(error) {
            console.error(`Graceful shutdown failed for ${  name  }: ${  shutdownErrorMessage(error)}`);
            process.exit(1);
        });
    }

    ["SIGINT", "SIGTERM"].forEach(function registerSignal(signal) {
        process.on(signal, function onSignal() { triggerShutdown(signal); });
    });

    process.on("disconnect", function onDisconnect() { triggerShutdown("disconnect"); });

    // Final safety net: close the LMDB env (which frees this process's reader slots) on any exit
    // path the graceful handler does not cover - process.exit() on a load error, an uncaught
    // exception, or an unhandled rejection. Node runs "exit" listeners synchronously for all of
    // these, and the close is idempotent, so this never double-closes after a graceful shutdown.
    process.on("exit", closeDatabaseEnv);
}

function loadPoolModule() {
    /** @type {Promise<Array<{poolPort: number, difficulty: number, portDesc: string, portType: string, hidden: number, ssl: number}>>} */
    const rows = global.mysql.query("SELECT * FROM port_config");
    return rows.then(function configurePorts(ports) {
        global.config.ports = ports.map((row) => ({
            port: row.poolPort,
            difficulty: row.difficulty,
            desc: row.portDesc,
            portType: row.portType,
            hidden: row.hidden === 1,
            ssl: row.ssl === 1
        }));
        return require('./lib/pool.js');
    });
}

/** @param {string} relativePath @param {string} optionalModuleName @returns {unknown} */
function loadOptionalLib2Module(relativePath, optionalModuleName) {
    const absolutePath = path.join(__dirname, relativePath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Optional module '${  optionalModuleName  }' requires lib2 at ${  absolutePath}`);
    }
    return require(relativePath);
}

/** @type {Record<string, () => unknown>} */
const moduleLoaders = {
    pool: loadPoolModule,
    block_manager () {
        const runtime = require('./lib/block_manager.js').createBlockManagerRuntime();
        runtime.start();
        return runtime;
    },
    altblock_manager () { return loadOptionalLib2Module('./lib2/altblock_manager.js', 'altblock_manager'); },
    altblock_exchange () { return loadOptionalLib2Module('./lib2/altblock_exchange.js', 'altblock_exchange'); },
    payments () { return require('./lib/payments.js'); },
    api () { return require('./lib/api.js'); },
    remote_share () { return require('./lib/remote_share.js'); },
    worker () { return require('./lib/worker.js'); },
    pool_stats () { return require('./lib/pool_stats.js'); },
    long_runner () { return require('./lib/long_runner.js'); }
};

// Config Table Layout
// <module>.<item>

/** @type {Promise<import("./lib/common/config_rows.js").ConfigRow[]>} */
const configRows = global.mysql.query("SELECT * FROM config");
configRows.then(function (rows) {
    applyConfigRows(global.config, rows);
}).then(async function(){
    global.config.coin = resolvedCoinConfig;
    coinInc = require(resolvedCoinConfig.funcFile);
    global.coinFuncs = new coinInc();
    if (moduleName === 'pool'){
        const RemoteDatabase = require('./lib/pool/remote_uplink');
        const remoteDatabase = new RemoteDatabase();
        remoteDatabase.initEnv();
        global.database = getRemoteDatabase(remoteDatabase);
    } else {
        const LocalDatabase = require('./lib/common/local_comms');
        const localDatabase = new LocalDatabase();
        localDatabase.initEnv();
        global.database = getInitializedLocalDatabase(localDatabase);
    }
    installGracefulShutdown((moduleName !== null) ? moduleName : ((toolName !== null) ? toolName : 'process'));
    global.coinFuncs.blockedAddresses.push(global.config.pool.address);
    global.coinFuncs.blockedAddresses.push(global.config.payout.feeAddress);
    if ((toolName !== null) && fs.existsSync(`./tools/${toolName}.js`)) {
        logStartup("tool", toolName);
        activeModule = require(`./tools/${toolName}.js`);
    } else if ((moduleName !== null)){
        const loader = Object.hasOwn(moduleLoaders, moduleName) ? moduleLoaders[moduleName] : null;
        if (!loader) {
            console.error("Invalid module provided.  Please provide a valid module");
            process.exit(1);
        }
        if (!cluster.isWorker) {
            console.log("");
            logStartup("module", moduleName);
        }
        await Promise.resolve().then(function runLoader() {
            return loader();
        }).then(function(loadedModule) {
            activeModule = loadedModule;
        }).catch(function onLoaderError(error) {
            console.error(`Failed to load module ${  moduleName  }: ${  shutdownErrorMessage(error)}`);
            process.exit(1);
        });
    } else {
        console.error("Invalid module/tool provided.  Please provide a valid module/tool");
        console.error(`Valid Modules: ${  Object.keys(moduleLoaders).join(", ")}`);
        console.error(`Valid Tools: ${  fs.readdirSync("./tools/").map(function(line) {
            return path.parse(line).name;
        }).join(", ")}`);
        process.exit(1);
    }
}).catch(function onStartupError(error) {
    console.error(`Pool startup failed while loading config: ${  shutdownErrorMessage(error)}`);
    console.error(`Exiting with status 1 in ${  STARTUP_FAILURE_RESTART_DELAY_MS / 1000  } seconds so PM2 can restart it`);
    setTimeout(function exitAfterStartupFailure() {
        process.exit(1);
    }, STARTUP_FAILURE_RESTART_DELAY_MS);
});
