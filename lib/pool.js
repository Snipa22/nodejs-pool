"use strict";
const debug = require('debug')('pool');
const crypto = require('crypto');
const bignum = require('bignum');
const cluster = require('cluster');
const btcValidator = require('wallet-address-validator');
const async = require('async');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const child_process = require('child_process');

const httpResponse  = ' 200 OK\nContent-Type: text/plain\nContent-Length: 18\n\nMining Pool Online';
const nonceCheck32  = new RegExp("^[0-9a-f]{8}$");
const nonceCheck64  = new RegExp("^[0-9a-f]{16}$");
const hashCheck32   = new RegExp("^[0-9a-f]{64}$");
const hexMatch      = new RegExp("^(?:[0-9a-f][0-9a-f])+$");
const baseDiff      = global.coinFuncs.baseDiff();
const baseRavenDiff = global.coinFuncs.baseRavenDiff();

const BLOCK_NOTIFY_PORT = 2223;
const DAEMON_POLL_MS = 500;

let decId = 0;
function get_new_id() {
    if (++decId > 999999999999999) decId = 0;
    return decId.toString(10);
};

function pad_hex(str, bytes) {
    const bytes2 = bytes * 2;
    return ("00".repeat(bytes) + str.substr(0, bytes2)).substr(-bytes2);
}

let ethJobId = 0;

function get_new_eth_job_id() {
    if (++ethJobId > 0xFFFF) ethJobId = 0;
    return pad_hex(ethJobId.toString(16), 2);
};

let uniqueWorkerId;
let uniqueWorkerIdBits;
let freeEthExtranonces = [];

function get_new_eth_extranonce_id() {
    if (!freeEthExtranonces.length) {
        const err_str = threadName + "Pool server " + global.config.hostname + " has overlow extranonce of " + (16 - uniqueWorkerIdBits) + " bits";
        console.error(err_str);
        global.support.sendEmail(global.config.general.adminEmail, "FYI: Pool node has extranonce overflow", err_str);
        return null;
    }
    return freeEthExtranonces.pop();
};

function eth_extranonce(id) {
    return id === null ? null : pad_hex(((id << uniqueWorkerIdBits) + uniqueWorkerId).toString(16), 2);
};

let bannedIPs = {};
let bannedAddresses = {};
let notifyAddresses = {};

let activeMiners = new Map();

let lastBlockHash        = {}; // coin key
let activeBlockTemplates = {}; // coin key
let pastBlockTemplates   = {}; // coin key -> global.support.circularBuffer -> activeBlockTemplates

let newCoinHashFactor    = {}; // coin key, current individual coin hash factor, set in updateCoinHashFactor
let lastCoinHashFactor   = {}; // coin key, last set individual coin hash factor, set in setNewCoinHashFactor
let lastCoinHashFactorMM = {}; // coin key, current individual coin hash factor that includes merged mining factor, set in setNewCoinHashFactor

let lastBlockFixTime  = {}; // time when blocks were checked to be in line with other nodes or when fix_daemon_sh was attempted
let lastBlockFixCount = {}; // number of times fix_daemon_sh was run

let threadName;
let minerCount = [];
let totalShares = 0, trustedShares = 0, normalShares = 0, invalidShares = 0, outdatedShares = 0, throttledShares = 0;

// wallet -> { connectTime, count (miner), hashes, last_ver_shares }
// this is need to thottle down some high share count miners
let minerWallets = {};
const MAX_VER_SHARES_PER_SEC = 5; // per thread
const VER_SHARES_PERIOD = 5;

Buffer.prototype.toByteArray = function () {
    return Array.prototype.slice.call(this, 0);
};

if (cluster.isMaster) {
    threadName = "(Master) ";
    setInterval(function () {
        let trustedSharesPercent   = (totalShares ? trustedShares   / totalShares * 100 : 0).toFixed(2);
        let normalSharesPercent    = (totalShares ? normalShares    / totalShares * 100 : 0).toFixed(2);
        let invalidSharesPercent   = (totalShares ? invalidShares   / totalShares * 100 : 0).toFixed(2);
        let outdatedSharesPercent  = (totalShares ? outdatedShares  / totalShares * 100 : 0).toFixed(2);
        let throttledSharesPercent = (totalShares ? throttledShares / totalShares * 100 : 0).toFixed(2);
        console.log(`>>> Trusted=${trustedShares}(${trustedSharesPercent}%) / Validated=${normalShares}(${normalSharesPercent}%) / Invalid=${invalidShares}(${invalidSharesPercent}%) / Outdated=${outdatedShares}(${outdatedSharesPercent}%) / Throttled=${throttledShares}(${throttledSharesPercent}%) / Total=${totalShares} shares`);
        totalShares     = 0;
        trustedShares   = 0;
        normalShares    = 0;
        invalidShares   = 0;
        outdatedShares  = 0;
        throttledShares = 0;
    }, 30*1000);
} else {
    threadName = "(Worker " + process.env['WORKER_ID'] + " - " + process.pid + ") ";
    // reset last verified share counters every VER_SHARES_PERIOD seconds
    setInterval(function () {
       for (let wallet in minerWallets) {
           minerWallets[wallet].last_ver_shares = 0;
       }
    }, VER_SHARES_PERIOD*1000);
}

global.database.thread_id = threadName;

const COINS = global.coinFuncs.getCOINS();

function registerPool() {
    global.mysql.query("SELECT * FROM pools WHERE id = ?", [global.config.pool_id]).then(function (rows) {
        rows.forEach(function (row) {
            if (row.ip !== global.config.bind_ip) {
                console.error("Pool ID in use already for a different IP. Update MySQL or change pool ID.");
                process.exit(1);
            }
        });
    }).then(function () {
        global.mysql.query("INSERT INTO pools (id, ip, last_checkin, active, hostname) VALUES (?, ?, now(), ?, ?) ON DUPLICATE KEY UPDATE last_checkin=now(), active=?",
            [global.config.pool_id, global.config.bind_ip, true, global.config.hostname, true]);
        global.mysql.query("DELETE FROM ports WHERE pool_id = ?", [global.config.pool_id]).then(function () {
            global.config.ports.forEach(function (port) {
                if ('ssl' in port && port.ssl === true) {
                    global.mysql.query("INSERT INTO ports (pool_id, network_port, starting_diff, port_type, description, hidden, ip_address, ssl_port) values (?, ?, ?, ?, ?, ?, ?, 1)",
                        [global.config.pool_id, port.port, port.difficulty, port.portType, port.desc, port.hidden, global.config.bind_ip]);
                } else {
                    global.mysql.query("INSERT INTO ports (pool_id, network_port, starting_diff, port_type, description, hidden, ip_address, ssl_port) values (?, ?, ?, ?, ?, ?, ?, 0)",
                        [global.config.pool_id, port.port, port.difficulty, port.portType, port.desc, port.hidden, global.config.bind_ip]);
                }
            });
        });
    });
}

// Master/Slave communication Handling
function messageHandler(message) {
    switch (message.type) {
        case 'banIP':
            debug(threadName + "Received ban IP update from nodes");
            if (cluster.isMaster) {
                sendToWorkers(message);
            } else {
                if (message.data != "127.0.0.1") bannedIPs[message.data] = 1;
            }
            break;
        case 'newBlockTemplate':
            debug(threadName + "Received new block template");
            setNewBlockTemplate(message.data);
            break;
        case 'newCoinHashFactor':
            debug(threadName + "Received new coin hash factor");
            setNewCoinHashFactor(true, message.data.coin, message.data.coinHashFactor);
            break;
        case 'minerPortCount':
            if (cluster.isMaster) minerCount[message.data.worker_id] = message.data.ports;
            break;
        case 'sendRemote':
            if (cluster.isMaster) {
                global.database.sendQueue.push({body: Buffer.from(message.body, 'hex')});
            }
            break;
        case 'trustedShare':
            ++ trustedShares;
            ++ totalShares;
            break;
        case 'normalShare':
            ++ normalShares;
            ++ totalShares;
            break;
        case 'invalidShare':
            ++ invalidShares;
            ++ totalShares;
            break;
        case 'outdatedShare':
            ++ outdatedShares;
            // total shares will be also increased separately as part of share type above
            break;
        case 'throttledShare':
            ++ throttledShares;
            ++ totalShares;
            break;
    }
}

process.on('message', messageHandler);

function sendToWorkers(data) {
    Object.keys(cluster.workers).forEach(function(key) {
        cluster.workers[key].send(data);
    });
}

function adjustMinerDiff(miner) {
    if (miner.fixed_diff) {
        const newDiff = miner.calcNewDiff();
        if (miner.difficulty * 10 < newDiff) {
            console.log("Dropped low fixed diff " + miner.difficulty + " for " + miner.logString + " miner to " + newDiff + " dynamic diff");
            miner.fixed_diff = false;
            if (miner.setNewDiff(newDiff)) return true;
        }
    } else if (miner.setNewDiff(miner.calcNewDiff())) {
        return true;
    }
    return false;
}

function retargetMiners() {
    debug(threadName + "Performing difficulty check on miners");

    global.config.ports.forEach(function (portData) { minerCount[portData.port] = 0; });
    const time_before = Date.now();
    for (var [minerId, miner] of activeMiners) {
        if (adjustMinerDiff(miner)) miner.sendSameCoinJob();
        ++ minerCount[miner.port];
    }
    const elapsed = Date.now() - time_before;
    if (elapsed > 50) console.error(threadName + "retargetMiners() consumed " + elapsed + " ms for " + activeMiners.size + " miners");
    process.send({type: 'minerPortCount', data: { worker_id: process.env['WORKER_ID'], ports: minerCount } });
}

// wallet " " proxy miner name -> { connectTime, count (miner), hashes }
// this is needed to set cummulative based diff for workers provided by Atreides proxy and xmrig-proxy
let proxyMiners = {};

function addProxyMiner(miner) {
    if (miner.proxyMinerName && miner.proxyMinerName in proxyMiners) return;

    const proxyMinerName = miner.payout; //+ ":" + miner.identifier;
    miner.proxyMinerName = proxyMinerName;

    if (!(proxyMinerName in proxyMiners)) {
        proxyMiners[proxyMinerName] = {};
        proxyMiners[proxyMinerName].connectTime = Date.now();
        proxyMiners[proxyMinerName].count = 1;
        proxyMiners[proxyMinerName].hashes = 0;
        console.log("Starting to calculate high diff for " + proxyMinerName + " proxy");
    } else {
        ++ proxyMiners[proxyMinerName].count;
    }
}

function removeMiner(miner) {
    const proxyMinerName = miner.proxyMinerName;
    if (proxyMinerName && proxyMinerName in proxyMiners && --proxyMiners[proxyMinerName].count <= 0) delete proxyMiners[proxyMinerName];
    if (miner.payout in minerWallets && --minerWallets[miner.payout].count <= 0) delete minerWallets[miner.payout]; 
    activeMiners.delete(miner.id);
    miner.removed_miner = true;
}

function checkAliveMiners() {
    debug(threadName + "Verifying if miners are still alive");
    const time_before = Date.now();
    const deadline = time_before - global.config.pool.minerTimeout * 1000;
    for (var [minerId, miner] of activeMiners) if (miner.lastContact < deadline) removeMiner(miner);
    const elapsed = Date.now() - time_before;
    if (elapsed > 50) console.error(threadName + "checkAliveMiners() consumed " + elapsed + " ms for " + activeMiners.size + " miners");
}

// coin hash factor is only updated in master thread
function updateCoinHashFactor(coin) {
    global.support.getCoinHashFactor(coin, function (coinHashFactor) {
        if (coinHashFactor === null) {
            console.error("Error getting coinHashFactor for " + coin + " coin");
            coinHashFactorUpdate(coin, newCoinHashFactor[coin] = 0);
        } else if (!coinHashFactor) {
            coinHashFactorUpdate(coin, newCoinHashFactor[coin] = 0);
        } else {
            newCoinHashFactor[coin] = coinHashFactor;
        }
    });
}

function process_rpc_template(rpc_template, coin, port, coinHashFactor, isHashFactorChange) {
    let template = Object.assign({}, rpc_template);

    template.coin               = coin;
    template.port               = parseInt(port);
    template.coinHashFactor     = coinHashFactor;
    template.isHashFactorChange = isHashFactorChange;

    if (port in global.coinFuncs.getMM_PORTS()) {
        const child_coin = global.coinFuncs.PORT2COIN(global.coinFuncs.getMM_PORTS()[port]);
        if (child_coin in activeBlockTemplates) {
            template.child_template            = activeBlockTemplates[child_coin];
            template.child_template_buffer     = template.child_template.buffer;
            template.parent_blocktemplate_blob = global.coinFuncs.constructMMParentBlockBlob(
                new Buffer(rpc_template.blocktemplate_blob, 'hex'), port, template.child_template_buffer
            ).toString('hex');
        }
    }

    return template;
}

// templateUpdateReal is only called in master thread (except the beginning of a worker thread)
function templateUpdateReal(coin, port, coinHashFactor, isHashFactorChange) {
    global.coinFuncs.getPortBlockTemplate(port, function (body_bt) {
        if (!newCoinHashFactor[coin]) {
            console.log("Aborting " + port + " last block template request because " + coin + " already has zero hash factor");
            return;
        }
        if (body_bt) {
            const template = process_rpc_template(body_bt, coin, port, coinHashFactor, isHashFactorChange);
            debug(threadName + "New block template found at " + template.height + " height");
            if (cluster.isMaster) {
                sendToWorkers({type: 'newBlockTemplate', data: template});
                setNewBlockTemplate(template);
                // update parent coins if current coin was updated now
                if (port in global.coinFuncs.getMM_CHILD_PORTS()) {
                    const parent_ports = global.coinFuncs.getMM_CHILD_PORTS()[port];
                    for (let parent_port in parent_ports) {
                        const parent_coin = global.coinFuncs.PORT2COIN(parent_port);
                        if (parent_coin in activeBlockTemplates) {
                            const parent_template = process_rpc_template(activeBlockTemplates[parent_coin], parent_coin, parent_port, lastCoinHashFactor[parent_coin], false);
                            sendToWorkers({type: 'newBlockTemplate', data: parent_template});
                            setNewBlockTemplate(parent_template);
                        }
                    }
                }
            } else {
                setNewBlockTemplate(template);
            }
        } else {
            console.error("Block template request failed for " + port + " port");
            coinHashFactorUpdate(coin, 0);
            setTimeout(templateUpdateReal, 3000, coin, port, coinHashFactor, isHashFactorChange);
        }
    });
}

function coinHashFactorUpdate(coin, coinHashFactor) {
    if (coin === "") return;
    if (coinHashFactor === 0 && lastCoinHashFactor[coin] === 0) return;
    if (cluster.isMaster) {
        //console.log('[*] New ' + coin + ' coin hash factor is set from ' + newCoinHashFactor[coin] + ' to ' + coinHashFactor);
        let data = { coin: coin, coinHashFactor: coinHashFactor };
        sendToWorkers({type: 'newCoinHashFactor', data: data});
    }
    setNewCoinHashFactor(true, coin, coinHashFactor);
}

// templateUpdate is only called in master thread (except the beginning of a worker thread)
function templateUpdate(coin, repeating) {
    const port           = global.coinFuncs.COIN2PORT(coin);
    const coinHashFactor = newCoinHashFactor[coin];
    if (coinHashFactor) global.coinFuncs.getPortLastBlockHeader(port, function (err, body) {
        if (!newCoinHashFactor[coin]) {
            console.log(threadName + "Aborting " + port + " last block header request because " + coin + " already has zero hash factor");
            if (repeating === true) setTimeout(templateUpdate, DAEMON_POLL_MS, coin, repeating);
        } else if (err === null && body.hash) {
            const isHashFactorChange = Math.abs(lastCoinHashFactor[coin] - coinHashFactor) / coinHashFactor > 0.05;
            if (!(coin in lastBlockHash) || body.hash !== lastBlockHash[coin]) {
                lastBlockHash[coin] = body.hash;
                templateUpdateReal(coin, port, coinHashFactor, isHashFactorChange);
            } else if (isHashFactorChange) {
                coinHashFactorUpdate(coin, coinHashFactor);
            }
            if (repeating === true) setTimeout(templateUpdate, DAEMON_POLL_MS, coin, repeating);
        } else {
            console.error(threadName + "Last block header request for " + port + " port failed!");
            coinHashFactorUpdate(coin, 0);
            if (repeating !== false) setTimeout(templateUpdate, 1000, coin, repeating);
        }
    }); else if (cluster.isMaster) {
        if (repeating !== false) setTimeout(templateUpdate, 1000, coin, repeating);
    }
}

// main chain anchor block height for alt chain block
let anchorBlockHeight;
let anchorBlockPrevHeight;

// update main chain anchor block height for alt chain block
// anchorBlockUpdate is only called in worker threads
function anchorBlockUpdate() {
    if (("" in activeBlockTemplates) && global.config.daemon.port == activeBlockTemplates[""].port) return;
    // only need to do that separately if we mine alt chain
    global.coinFuncs.getLastBlockHeader(function (err, body) {
        if (err === null) {
            anchorBlockHeight = body.height + 1;
            if (!anchorBlockPrevHeight || anchorBlockPrevHeight != anchorBlockHeight) {
                anchorBlockPrevHeight = anchorBlockHeight;
                debug("Anchor block was changed to " + anchorBlockHeight);
            }
        } else {
            console.error("Archor last block header request failed!");
        }
    });
}

function getCoinJobParams(coin) {
    let params = {};
    params.bt             = activeBlockTemplates[coin];
    params.coinHashFactor = lastCoinHashFactorMM[coin];
    params.algo_name      = global.coinFuncs.algoShortTypeStr(params.bt.port, params.bt.block_version);
    //params.variant_name   = params.algo_name.split('/')[1];
    return params;
};

function setNewCoinHashFactor(isHashFactorChange, coin, coinHashFactor, check_height) {
    if (isHashFactorChange) lastCoinHashFactor[coin] = coinHashFactor;
    const prevCoinHashFactorMM = lastCoinHashFactorMM[coin];
    lastCoinHashFactorMM[coin] = coinHashFactor; // used in miner.selectBestCoin

    const port = global.coinFuncs.COIN2PORT(coin);
    const is_mm = port in global.coinFuncs.getMM_PORTS();
    if (is_mm) {
        const child_coin = global.coinFuncs.PORT2COIN(global.coinFuncs.getMM_PORTS()[port]);
        lastCoinHashFactorMM[coin] += lastCoinHashFactor[child_coin];
    }

    if (cluster.isMaster && coin !== "" && prevCoinHashFactorMM != lastCoinHashFactorMM[coin]) {
        console.log('[*] New ' + coin + ' coin hash factor is set from ' + prevCoinHashFactorMM + ' to ' + coinHashFactor + (is_mm ? ' (MM: ' + lastCoinHashFactorMM[coin] + ')' : ""));
    }
    if (!(coin in activeBlockTemplates)) return;

    // update parent coins if current coin was updated now
    if (isHashFactorChange) if (port in global.coinFuncs.getMM_CHILD_PORTS()) {
        const parent_ports = global.coinFuncs.getMM_CHILD_PORTS()[port];
        for (let parent_port in parent_ports) {
            const parent_coin = global.coinFuncs.PORT2COIN(parent_port);
            setNewCoinHashFactor(true, parent_coin, lastCoinHashFactor[parent_coin], 0);
        }
    }

    const time_before = Date.now();
    let strLogPrefix;

    if (isHashFactorChange) {
        const port          = activeBlockTemplates[coin].port;
        const block_version = activeBlockTemplates[coin].block_version;
        const algo          = global.coinFuncs.algoShortTypeStr(port, block_version);

        strLogPrefix = "Full BT update for coin " + coin;
        if (cluster.isMaster) console.log(threadName + strLogPrefix + " with hash factor changed to " + lastCoinHashFactorMM[coin]);

        if (check_height) {
            for (var [minerId, miner] of activeMiners) {
                if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) continue;
                miner.trust.check_height = check_height;
                miner.sendBestCoinJob();
            }
        } else {
            for (var [minerId, miner] of activeMiners) {
                if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) continue;
                miner.sendBestCoinJob();
            }
        }

    } else {

        strLogPrefix = "Fast BT update for coin " + coin;
        if (cluster.isMaster) console.log(threadName + strLogPrefix + " with the same " + lastCoinHashFactorMM[coin] + " hash factor");

        const params = getCoinJobParams(coin);
        if (check_height) {
            for (var [minerId, miner] of activeMiners) {
                //if (typeof(miner.curr_coin) === 'undefined') console.error("[INTERNAL ERROR]: " + miner.logString + ": undefined curr_coin");
                if (miner.curr_coin !== coin) continue;
                //if (!(coin in miner.coin_perf)) console.error("[INTERNAL ERROR]: " + miner.logString + ": no longer supported coin " + coin + " in miner " + JSON.stringify(miner.coin_perf) + " coin_perf");
                //if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) console.error("[INTERNAL ERROR]: " + miner.logString + ": no longer supported algo " + algo + " in miner " + JSON.stringify(miner.algos) + " algos");
                miner.trust.check_height = check_height;
                miner.sendCoinJob(coin, params);
            }
        } else {
            for (var [minerId, miner] of activeMiners) {
                //if (typeof(miner.curr_coin) === 'undefined') console.error("[INTERNAL ERROR]: " + miner.logString + ": undefined curr_coin");
                if (miner.curr_coin !== coin) continue;
                //if (!(coin in miner.coin_perf)) console.error("[INTERNAL ERROR]: " + miner.logString + ": no longer supported coin " + coin + " in miner " + JSON.stringify(miner.coin_perf) + " coin_perf");
                //if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) console.error("[INTERNAL ERROR]: " + miner.logString + ": no longer supported algo " + algo + " in miner " + JSON.stringify(miner.algos) + " algos");
                miner.sendCoinJob(coin, params);
            }
        }
    }

    const elapsed = Date.now() - time_before;
    if (elapsed > 50) console.error(threadName + strLogPrefix + " setNewCoinHashFactor() consumed " + elapsed + " ms for " + activeMiners.size + " miners");
}

function setNewBlockTemplate(template) {
    const coin = template.coin;
    let isExtraCheck = false;
    if (coin in activeBlockTemplates) {
        if (activeBlockTemplates[coin].prev_hash === template.prev_hash) {
            if ("child_template" in template) {
                if ("child_template" in activeBlockTemplates[coin] && activeBlockTemplates[coin].child_template.prev_hash === template.child_template.prev_hash) {
                    console.log(threadName + 'Ignoring duplicate parent block template update at height: ' + template.height + '. Difficulty: ' + template.difficulty);
                    return;
                }
            } else {
                console.log(threadName + 'Ignoring duplicate block template update at height: ' + template.height + '. Difficulty: ' + template.difficulty);
                return;
            }
        }
        activeBlockTemplates[coin].timeCreated = Date.now();
        if (coin in pastBlockTemplates) {
            pastBlockTemplates[coin].get(0).timeoutTime = Date.now() + 4*1000;
        } else {
            pastBlockTemplates[coin] = global.support.circularBuffer(10);
        }
        pastBlockTemplates[coin].enq(activeBlockTemplates[coin]);
        if (activeBlockTemplates[coin].port != template.port && global.config.pool.trustedMiners) isExtraCheck = true;
    }
    if (cluster.isMaster) {
        const coin_str = coin === "" ? "" : coin + " ";
        console.log('[*] New ' + coin_str + 'block to mine at ' + template.height + ' height with ' + template.difficulty + ' difficulty and ' + template.port + ' port (with coin hash factor ' + template.coinHashFactor + ")");
    } else {
        debug(threadName + 'New block to mine at ' + template.height + ' height with ' + template.difficulty + ' difficulty and ' + template.port + ' port');
    }

    activeBlockTemplates[coin] = new global.coinFuncs.BlockTemplate(template);

    const height = activeBlockTemplates[coin].height;

    if (coin === "" && global.config.daemon.port == activeBlockTemplates[""].port) {
        anchorBlockHeight = height;
    }

    setNewCoinHashFactor(template.isHashFactorChange, coin, template.coinHashFactor, isExtraCheck ? height : 0);
}

// here we keep verified share number of a specific wallet (miner.payout)
// it will reset to 0 after invalid share is found
// if walletTrust exceeds certain threshold (global.config.pool.trustThreshold * 100) then low diff (<=16000) new workers for this wallet are started with high trust
// this is needed to avoid CPU overload after constant miner reconnections that happen during mining botnet swarms
let walletTrust = {};
// wallet last seen time (all wallets that are not detected for more than 1 day are removed)
let walletLastSeeTime = {};

// miner agent strings (for process.env['WORKER_ID'] == 1)
let minerAgents = {};

var reEmail = /^\S+@\S+\.\S+$/;
// wallet password last check time
let walletLastCheckTime = {};

let wallet_debug = {};

function getTargetHex(diff, size) {
    return pad_hex(baseDiff.div(diff).toBuffer({endian: 'little', size: size}).toString('hex'), size);
};

function getRavenTargetHex(diff) {
    return pad_hex((baseRavenDiff / diff).toString(16), 32);
};

function Miner(id, login, pass, ipAddress, startingDiff, pushMessage, protoVersion, portType, port, agent, algos, algos_perf, algo_min_time) {
    // Username Layout - <address in BTC or XMR>.<Difficulty>
    // Password Layout - <password>.<miner identifier>.<payment ID for XMR>
    // Default function is to use the password so they can login.  Identifiers can be unique, payment ID is last.
    // If there is no miner identifier, then the miner identifier is set to the password
    // If the password is x, aka, old-logins, we're not going to allow detailed review of miners.

    const login_diff_split      = login.split("+");
    const login_div_split       = login_diff_split[0].split("%");
    const login_paymentid_split = login_div_split[0].split(".");
    const pass_algo_split       = pass.split("~");
    let   pass_split            = pass_algo_split[0].split(":");

    // Workaround for a common mistake to put email without : before it
    // and also security measure to hide emails used as worker names
    if (pass_split.length === 1 && reEmail.test(pass_split[0])) {
        pass_split.push(pass_split[0]);
        pass_split[0] = "email";
    }

    // 1) set payout, identifier, email and logString

    this.payout = this.address = login_paymentid_split[0];
    this.paymentID = null;

    this.identifier = agent && agent.includes('MinerGate') ? "MinerGate" : pass_split[0].substring(0, 64);
    if (typeof(login_paymentid_split[1]) !== 'undefined') {
        if (login_paymentid_split[1].length === 64 && hexMatch.test(login_paymentid_split[1]) && global.coinFuncs.validatePlainAddress(this.address)) {
            this.paymentID = login_paymentid_split[1];
            this.payout += "." + this.paymentID;
            if (typeof(login_paymentid_split[2]) !== 'undefined' && this.identifier === 'x') {
                this.identifier = login_paymentid_split[2].substring(0, 64);
            }
        } else if (this.identifier === 'x') {
            this.identifier = login_paymentid_split[1].substring(0, 64);
        }
    }

    this.debugMiner = this.payout in wallet_debug;
    this.email      = pass_split.length === 2 ? pass_split[1] : "";
    this.logString  = this.payout.substr(this.payout.length - 10) + ":" + this.identifier + " (" + ipAddress + ")";
    this.agent      = agent;

    // 2) check stuff

    if (login_diff_split.length > 2) {
        this.error = "Please use monero_address[.payment_id][+difficulty_number] login/user format";
        this.valid_miner = false;
        return;
    }

    if (Math.abs(login_div_split.length % 2) == 0 || login_div_split.length > 5) {
        this.error = "Please use monero_address[.payment_id][%N%95_char_long_monero_wallet_address]+[+difficulty_number] login/user format";
        this.valid_miner = false;
        return;
    }

    this.payout_div = {};

    let payout_percent_left = 100;
    for (let index = 1; index < login_div_split.length - 1; index += 2) {
        const percent = parseFloat(login_div_split[index]);
        if (isNaN(percent) || percent < 0.1) {
            this.error = "Your payment divide split " + percent + " is below 0.1% and can't be processed";
            this.valid_miner = false;
            return;
        }
        if (percent > 99.9) {
            this.error = "Your payment divide split " + percent + " is above 99.9% and can't be processed";
            this.valid_miner = false;
            return;
        }
        payout_percent_left -= percent;
        if (payout_percent_left < 0.1) {
            this.error = "Your summary payment divide split exceeds 99.9% and can't be processed";
            this.valid_miner = false;
            return;
        }
        const address = login_div_split[index + 1];
        if (address.length != 95 || !global.coinFuncs.validateAddress(address)) {
            this.error = "Invalid payment address provided: " + address + ". Please use 95_char_long_monero_wallet_address format";
            this.valid_miner = false;
            return;
        }
        if (address in bannedAddresses) { // Banned Address
            this.error = "Permanently banned payment address " + address + " provided: " + bannedAddresses[address];
            this.valid_miner = false;
            return;
        }
        if (address in this.payout_div) {
            this.error = "You can't repeat payment split address " + address;
            this.valid_miner = false;
            return;
        }
        this.payout_div[address] = percent;
    }

    if (payout_percent_left === 100) {
        this.payout_div = null;
    } else {
        if (this.payout in this.payout_div) {
            this.error = "You can't repeat payment split address " + this.payout;
            this.valid_miner = false;
            return;
        }
        this.payout_div[this.payout] = payout_percent_left;
    }

    if (pass_split.length > 2) {
        this.error = "Please use worker_name[:email] password format";
        this.valid_miner = false;
        return;
    }

    if (this.payout in bannedAddresses) { // Banned Address
        this.error = "Permanently banned payment address " + this.payout + " provided: " + bannedAddresses[this.payout];
        this.valid_miner = false;
        return;
    }

    if (global.coinFuncs.exchangeAddresses.indexOf(this.address) !== -1 && !(this.paymentID)) {
        this.error = "Exchange addresses need 64 hex character long payment IDs. Please specify it after your wallet address as follows after dot: Wallet.PaymentID";
        this.valid_miner = false;
        return;
    }

    if (global.coinFuncs.validateAddress(this.address)) {
        this.bitcoin = 0;
    } else if (global.config.general.allowBitcoin && global.coinFuncs.supportsAutoExchange && btcValidator.validate(this.address)) {
        this.bitcoin = 1;
    } else {
        this.error = "Invalid payment address provided: " + this.address + ". Please use 95_char_long_monero_wallet_address format";
        this.valid_miner = false;
        return;
    }

    if (!("" in activeBlockTemplates)) {
        this.error = "No active block template";
        this.valid_miner = false;
        return;
    }

    this.setAlgos = function(algos, algos_perf, algo_min_time) {
        this.algos = {};
        for (let i in algos) this.algos[algos[i]] = 1;
        if (global.coinFuncs.is_miner_agent_no_haven_support(this.agent)) delete this.algos["cn-heavy/xhv"];
        const check = global.coinFuncs.algoCheck(this.algos);
        if (check !== true) return check;
        if ("cn-pico" in this.algos) this.algos["cn-pico/trtl"] = 1;

        if (!(algos_perf && algos_perf instanceof Object)) {
          if (global.coinFuncs.algoMainCheck(this.algos)) algos_perf = global.coinFuncs.getDefaultAlgosPerf();
          else algos_perf = global.coinFuncs.getPrevAlgosPerf();
        }

        let coin_perf = global.coinFuncs.convertAlgosToCoinPerf(algos_perf);
        if (coin_perf instanceof Object) {
            if (!("" in coin_perf && global.coinFuncs.algoMainCheck(this.algos))) coin_perf[""] = -1;
            this.coin_perf = coin_perf;
        } else {
            return coin_perf;
        }
        this.algo_min_time = algo_min_time ? algo_min_time : 0;
        return "";
    };

    if (pass_algo_split.length == 2) {
       const algo_name = pass_algo_split[1];
       algos         = [ algo_name ];
       algos_perf    = {};
       algos_perf[algo_name] = 1;
       algo_min_time = 0;

    } else if (!(algos && algos instanceof Array && global.config.daemon.enableAlgoSwitching)) {
       const agent_algo = global.coinFuncs.get_miner_agent_not_supported_algo(agent);
       if (agent_algo) {
           algos  = [ agent_algo ];
       } else {
           algos  = global.coinFuncs.getDefaultAlgos();
       }
       algos_perf    = global.coinFuncs.getDefaultAlgosPerf();
       algo_min_time = 0;
    }

    const status = this.setAlgos(algos, algos_perf, algo_min_time);
    if (status != "") {
        this.error = status;
        this.valid_miner = false;
        return;
    }


    // 3) setup valid miner stuff

    // 3a) misc stuff

    this.error = "";
    this.valid_miner = true;
    this.removed_miner = false;

    this.proxy = agent && agent.includes('xmr-node-proxy');
    this.id = id;
    this.ipAddress = ipAddress;
    this.pushMessage = pushMessage;
    this.connectTime = Date.now();
    this.heartbeat = function () { this.lastContact = Date.now(); };
    this.heartbeat();

    // 3b) port stuff
   
    this.port = port;
    this.portType = portType;
    switch (portType) {
        case 'pplns': this.poolTypeEnum = global.protos.POOLTYPE.PPLNS; break;
        case 'pps':   this.poolTypeEnum = global.protos.POOLTYPE.PPS;   break;
        case 'solo':  this.poolTypeEnum = global.protos.POOLTYPE.SOLO;  break;
        case 'prop':  this.poolTypeEnum = global.protos.POOLTYPE.PROP;  break;
        default:      console.error("Wrong portType " + portType);
                      this.poolTypeEnum = global.protos.POOLTYPE.PPLNS;
    }

    this.wallet_key = this.payout + " " + this.bitcoin + " " + this.poolTypeEnum + " " + JSON.stringify(this.payout_div) + " ";

    // 3c) diff calc stuff

    this.lastShareTime = Math.floor(Date.now() / 1000);
    this.validShares = 0;
    this.invalidShares = 0;
    this.hashes = 0;

    // 3d) trust stuff

    if (global.config.pool.trustedMiners) {
        if (!(this.payout in walletTrust)) {
            walletTrust[this.payout] = 0;
            walletLastSeeTime[this.payout] = Date.now();
        }
        this.trust = {
            trust:        0,
            check_height: 0
        };
    }

    // 3e) password setup stuff

    let email = this.email.trim();
    if (email != "") {
        // Need to do an initial registration call here.  Might as well do it right...
        let payoutAddress = this.payout;
        let time_now = Date.now();
        if (!(payoutAddress in walletLastCheckTime) || time_now - walletLastCheckTime[payoutAddress] > 60*1000) {
            global.mysql.query("SELECT id FROM users WHERE username = ? LIMIT 1", [payoutAddress]).then(function (rows) {
                if (rows.length > 0) return;
                if (global.coinFuncs.blockedAddresses.indexOf(payoutAddress) !== -1) return;
                global.mysql.query("INSERT INTO users (username, email) VALUES (?, ?)", [payoutAddress, email]);
                console.log("Setting password " + email + " for " + payoutAddress);
            });
            walletLastCheckTime[payoutAddress] = time_now;
        }
    }

    this.validJobs = global.support.circularBuffer(10);
    this.cachedJob = null;

    this.storeInvalidShare = function() {
        global.database.storeInvalidShare(global.protos.InvalidShare.encode({
            paymentAddress: this.address,
            paymentID:      this.paymentID,
            identifier:     this.identifier
        }));
    };

    this.setNewDiff = function (difficulty) {
        if (this.fixed_diff) return false;
        const newDiff = difficulty;
        this.newDiffRecommendation = newDiff;
        const ratio = Math.abs(newDiff - this.difficulty) / this.difficulty;
        if (ratio < 0.2) return false;
        this.newDiffToSet = newDiff;

        debug(threadName + "Difficulty change to: " + this.newDiffToSet + " For: " + this.logString);
        if (this.hashes > 0) {
            debug(threadName + "Hashes: " + this.hashes + " in: " + Math.floor((Date.now() - this.connectTime) / 1000) + " seconds gives: " +
                Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) + " hashes/second or: " +
                Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) * global.config.pool.targetTime + " difficulty versus: " + this.newDiffToSet);
        }
        return true;
    };

    this.selectBestCoin = function() {
        if (this.debugMiner) console.log(threadName + this.logString + " [WALLET DEBUG] current coin is " + this.curr_coin);
        if (typeof(this.curr_coin) !== 'undefined' && this.curr_coin_time && lastCoinHashFactorMM[this.curr_coin] &&
            Date.now() - this.curr_coin_time < this.algo_min_time*1000
        ) {
           return this.curr_coin;
        }
        let best_coin = "";
        let best_coin_perf = this.coin_perf[""] * 1.1;
        let miner = this;
        COINS.forEach(function(coin) {
            if (!(coin in miner.coin_perf)) {
                if (miner.debugMiner) console.log(threadName + miner.logString + " [WALLET DEBUG] " + coin + ": no coin_perf");
                return;
            }
            if (!(coin in activeBlockTemplates)) {
                if (miner.debugMiner) console.log(threadName + miner.logString + " [WALLET DEBUG] " + coin + ": no activeBlockTemplates");
                return;
            }
            const coinHashFactor = lastCoinHashFactorMM[coin];
            if (!coinHashFactor) {
                if (miner.debugMiner) console.log(threadName + miner.logString + " [WALLET DEBUG] " + coin + ": no coinHashFactor");
                return;
            }
            const bt            = activeBlockTemplates[coin];
            const port          = bt.port;
            const block_version = bt.block_version;
            const algo          = global.coinFuncs.algoShortTypeStr(port, block_version);

            if (miner.difficulty / coinHashFactor > bt.difficulty * 3) {
                if (miner.debugMiner) console.log(threadName + miner.logString + " [WALLET DEBUG] Rejected best " + coin + " coin due to high diff " + miner.difficulty + " " + coinHashFactor + " " + bt.difficulty);
                return;
            }
            if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) {
                if (miner.debugMiner) console.log(threadName + miner.logString + " [WALLET DEBUG] " + coin + ": no algo support");
                return;
            }
            let coin_perf = miner.coin_perf[coin] * coinHashFactor;
            if (miner.curr_coin === coin) coin_perf *= 1.05;
            if (miner.debugMiner) console.log(threadName + miner.logString + " [WALLET DEBUG] " + coin + ": " + coin_perf);
            if (coin_perf > best_coin_perf) {
                best_coin      = coin;
                best_coin_perf = coin_perf;
            }
        });
        if (best_coin_perf < 0) return false;
        if (typeof(this.curr_coin) === 'undefined' || this.curr_coin != best_coin) {
            const blob_type_num = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(best_coin));
            if (global.coinFuncs.blobTypeGrin(blob_type_num)) {
                this.curr_coin_min_diff = 1;
            } else if (global.coinFuncs.blobTypeRaven(blob_type_num)) {
                this.curr_coin_min_diff = 0.01;
            } else if (global.coinFuncs.blobTypeEth(blob_type_num)) {
                this.curr_coin_min_diff = 0.01 * 0x100000000;
            } else {
                this.curr_coin_min_diff = global.config.pool.minDifficulty;
            }
            this.curr_coin             = best_coin;
            this.curr_coin_hash_factor = lastCoinHashFactorMM[best_coin];
            this.curr_coin_time        = Date.now();
            if (global.config.pool.trustedMiners) this.trust.check_height = activeBlockTemplates[best_coin].height;
        }
        return best_coin;
    };

    // 3e) set diff stuff
 
    this.fixed_diff = false;
    this.difficulty = startingDiff;

    if (login_diff_split.length === 2) {
        this.fixed_diff = true;
        this.difficulty = Number(login_diff_split[1]);
        if (this.difficulty < global.config.pool.minDifficulty) {
            this.difficulty = global.config.pool.minDifficulty;
        }
        if (this.difficulty > global.config.pool.maxDifficulty) {
            this.difficulty = global.config.pool.maxDifficulty;
        }
    }

    this.curr_coin_hash_factor = 1;
    this.curr_coin_min_diff = global.config.pool.minDifficulty;
    this.curr_coin = this.selectBestCoin();

    if (agent && agent.includes('NiceHash')) {
        this.fixed_diff = true;
        let minNiceHashDiff;
	const blob_type_num = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(this.curr_coin));
        if (global.coinFuncs.blobTypeRaven(blob_type_num) || global.coinFuncs.blobTypeEth(blob_type_num)) {
            minNiceHashDiff = global.coinFuncs.niceHashDiff * 50;
        } else {
            minNiceHashDiff = global.coinFuncs.niceHashDiff;
        }

        if (this.difficulty < minNiceHashDiff) this.difficulty = minNiceHashDiff;
    }

    this.calcNewDiff = function () {
        const proxyMinerName = this.payout; // + ":" + this.identifier;
        let miner;
        let target;
        let min_diff;
        let history_time;
        if (proxyMinerName in proxyMiners) {
            miner = proxyMiners[proxyMinerName];
            target = 15;
            min_diff = 10 * global.config.pool.minDifficulty;
            history_time = 5;
            if (this.debugMiner) console.log(threadName + this.logString + " [WALLET DEBUG] calc proxy miner diff: " + miner.hashes + " / " + ((Date.now() - miner.connectTime) / 1000));
        } else if (this.payout in minerWallets && minerWallets[this.payout].last_ver_shares >= MAX_VER_SHARES_PER_SEC * VER_SHARES_PERIOD) {
            miner = minerWallets[this.payout];
            target = 15;
            min_diff = 10 * global.config.pool.minDifficulty;
            history_time = 5;
            if (this.debugMiner) console.log(threadName + this.logString + " [WALLET DEBUG] calc throttled miner diff: " + miner.hashes + " / " + ((Date.now() - miner.connectTime) / 1000));
        } else {
            miner = this;
            target = this.proxy ? 15 : global.config.pool.targetTime;
            min_diff = this.proxy ? 10 * global.config.pool.minDifficulty : global.config.pool.minDifficulty;
            history_time = 60;
            if (this.debugMiner) console.log(threadName + this.logString + " [WALLET DEBUG] calc miner diff: " + miner.hashes + " / " + ((Date.now() - miner.connectTime) / 1000));
        }
        if (miner.connectTimeShift) {
            const timeSinceLastShift = Date.now() - miner.connectTimeShift;
            const timeWindow         = history_time * 60 * 1000;
            if (timeSinceLastShift > timeWindow) {
                if (timeSinceLastShift > 2 * timeWindow) { // forget all
                    if (this.debugMiner) console.log(threadName + this.logString + " [WALLET DEBUG] forget diff");
                    miner.hashes = 0;
                } else {
                    if (this.debugMiner) console.log(threadName + this.logString + " [WALLET DEBUG] diff window shift from " + miner.connectTimeShift + " and " + miner.hashesShift + " hashes");
                    miner.hashes -= miner.hashesShift;
                }
                miner.connectTime = miner.connectTimeShift;
                miner.connectTimeShift = Date.now();
                miner.hashesShift = miner.hashes;
            }
        } else {
            miner.connectTimeShift = Date.now();
            miner.hashesShift = miner.hashes;
        }

        let hashes = miner.hashes;
        let period = (Date.now() - miner.connectTime) / 1000;

        if (hashes === 0) {
            hashes = this.difficulty;
            target = 2 * global.config.pool.retargetTime;
            if (period < target) period = target;
        }
        const diff = hashes * target / period;
        return diff < min_diff ? min_diff : diff;
    };

    this.checkBan = function (validShare) {
        if (!global.config.pool.banEnabled) return;

        // Valid stats are stored by the pool.
        if (validShare) {
          ++ this.validShares;
        } else {
          if (this.validShares === 0) {
            console.error(threadName + "Suspended miner IP for submitting bad share with zero trust " + this.logString);
            removeMiner(this);
            process.send({type: 'banIP', data: this.ipAddress});
            return;
          }
          ++ this.invalidShares;
        }

        const shareCount = this.validShares + this.invalidShares;
        if (shareCount >= global.config.pool.banThreshold) {
            if (100 * this.invalidShares / shareCount >= global.config.pool.banPercent) {
                console.error(threadName + "Suspended miner IP for submitting too many bad shares recently " + this.logString);
                removeMiner(this);
                process.send({type: 'banIP', data: this.ipAddress});
            } else {
                this.invalidShares = 0;
                this.validShares   = 0;
            }
        }
    };

    if (protoVersion === 1) {
        this.getCoinJob = function (coin, params) {
            const bt = params.bt;
            if (this.jobLastBlockHash === bt.idHash && !this.newDiffToSet && this.cachedJob !== null) return null;
            this.jobLastBlockHash = bt.idHash;

            if (this.newDiffToSet) {
                this.difficulty            = this.newDiffToSet;
                this.newDiffToSet          = null;
                this.newDiffRecommendation = null;
            } else if (this.newDiffRecommendation) {
                this.difficulty            = this.newDiffRecommendation;
                this.newDiffRecommendation = null;
            }

            let coin_diff = this.difficulty / this.curr_coin_hash_factor;
            if (coin_diff < this.curr_coin_min_diff) coin_diff = this.curr_coin_min_diff;
            if (coin_diff > bt.difficulty) coin_diff = bt.difficulty;

            const blob_type_num = global.coinFuncs.portBlobType(bt.port);
            const isEth = global.coinFuncs.blobTypeEth(blob_type_num);

            if (!this.proxy || isEth) {
                const blob_hex = bt.nextBlobHex();
                if (!blob_hex) return null;
                const isGrin = global.coinFuncs.blobTypeGrin(blob_type_num);
                const isRvn  = global.coinFuncs.blobTypeRaven(blob_type_num);
                const newJob = {
                    id:             isRvn ? get_new_eth_job_id() : get_new_id(),
                    coin:           coin,
                    blob_type_num:  blob_type_num,
                    blockHash:      bt.idHash,
                    extraNonce:     isEth ? this.eth_extranonce : bt.extraNonce,
                    height:         bt.height,
                    seed_hash:      bt.seed_hash,
                    difficulty:     coin_diff,
                    norm_diff:      coin_diff * this.curr_coin_hash_factor,
                    coinHashFactor: params.coinHashFactor,
                    submissions:    {}
                };
                this.validJobs.enq(newJob);
                if (isGrin) this.cachedJob = {
                    pre_pow:    blob_hex,
                    algo:       this.protocol === "grin" ? "cuckaroo" : params.algo_name,
                    edgebits:   29,
		    proofsize:  global.coinFuncs.c29ProofSize(blob_type_num),
		    noncebytes: 4,
                    height:     bt.height,
                    job_id:     newJob.id,
                    difficulty: coin_diff,
                    id:         this.id
                }; else if (isRvn) this.cachedJob = [
	            newJob.id,
                    blob_hex,
                    bt.seed_hash,
                    getRavenTargetHex(coin_diff),
                    true,
                    bt.height,
                    bt.bits
                ]; else if (isEth) this.cachedJob = [
                    newJob.id,
                    bt.seed_hash,
                    blob_hex,
                    true,
                    coin_diff
                ]; else this.cachedJob = {
                    blob:       blob_hex,
                    algo:       params.algo_name,
                    height:     bt.height,
                    seed_hash:  bt.seed_hash,
                    job_id:     newJob.id,
                    target:     getTargetHex(coin_diff, global.coinFuncs.nonceSize(blob_type_num)),
                    id:         this.id
                };
            } else {
                const blob_hex = bt.nextBlobWithChildNonceHex();
                const newJob = {
                    id:                  get_new_id(),
                    coin:                coin,
                    blob_type_num:       blob_type_num,
                    blockHash:           bt.idHash,
                    extraNonce:          bt.extraNonce,
                    height:              bt.height,
                    seed_hash:           bt.seed_hash,
                    difficulty:          coin_diff,
                    clientPoolLocation:  bt.clientPoolLocation,
                    clientNonceLocation: bt.clientNonceLocation,
                    coinHashFactor:      params.coinHashFactor,
                    submissions:         {}
                };
                this.validJobs.enq(newJob);
                this.cachedJob = {
                    blocktemplate_blob:  blob_hex,
                    blob_type:           global.coinFuncs.blobTypeStr(bt.port, bt.block_version),
                    algo:                params.algo_name,
                    difficulty:          bt.difficulty,
                    height:              bt.height,
                    seed_hash:           bt.seed_hash,
                    reserved_offset:     bt.reserved_offset,
                    client_nonce_offset: bt.clientNonceLocation,
                    client_pool_offset:  bt.clientPoolLocation,
                    target_diff:         coin_diff,
                    job_id:              newJob.id,
                    id:                  this.id
                };
            }
            return this.cachedJob;
        };

        this.sendCoinJob = function(coin, params) {
            const job = this.getCoinJob(coin, params);
            if (job === null) return;
            const blob_type_num = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(coin));
            if (this.protocol == "grin") {
                return this.pushMessage({method: "getjobtemplate", result: job});
            } else if (global.coinFuncs.blobTypeRaven(blob_type_num)) {
                const target = job[3];
                if (!this.last_target || this.last_target !== target) {
                    this.pushMessage({method: "mining.set_target", params: [ target ], id:null});
                    this.last_target = target;
                }
                return this.pushMessage({method: "mining.notify", params: job, algo: params.algo_name, id:null});
            } else if (global.coinFuncs.blobTypeEth(blob_type_num)) {
                const diff = job.pop() / 0x100000000;
                if (!this.last_diff || this.last_diff !== diff) {
                    this.pushMessage({method: "mining.set_difficulty", params: [ diff ]});
                    this.last_diff = diff;
                }
                return this.pushMessage({method: "mining.notify", params: job, algo: params.algo_name});

            } else {
                return this.pushMessage({method: "job", params: job});
            }
        };

        this.sendSameCoinJob = function () {
            const coin = typeof(this.curr_coin) !== 'undefined' ? this.curr_coin : this.selectBestCoin();
            if (coin !== false) return this.sendCoinJob(coin, getCoinJobParams(coin));
        };

        this.getBestCoinJob = function() {
            const coin = this.selectBestCoin();
            if (coin !== false) return this.getCoinJob(coin, getCoinJobParams(coin));
        };

        this.sendBestCoinJob = function() {
            const coin = this.selectBestCoin();
            if (coin !== false) return this.sendCoinJob(coin, getCoinJobParams(coin));
        };
    }
}

// store wallet_key (address, paymentID, bitcoin, poolTypeEnum, port) -> worker_name -> isTrustedShare -> (height, difficulty, time, acc, acc2)
let walletAcc             = {};
// number of worker_name for wallet_key (so we do not count them by iteration)
let walletWorkerCount     = {};
// is share finalizer function for dead worker_name is active
let is_walletAccFinalizer = {};

function storeShareDiv(miner, share_reward, share_reward2, share_num, worker_name, bt_port, bt_height, bt_difficulty, isBlockCandidate, isTrustedShare) {
    const time_now = Date.now();
    if (miner.payout_div === null) {
        global.database.storeShare(bt_height, global.protos.Share.encode({
            paymentAddress: miner.address,
            paymentID:      miner.paymentID,
            raw_shares:     share_reward,
            shares2:        share_reward2,
            share_num:      share_num,
            identifier:     worker_name,
            port:           bt_port,
            blockHeight:    bt_height,
            blockDiff:      bt_difficulty,
            poolType:       miner.poolTypeEnum,
            bitcoin:        miner.bitcoin,
            foundBlock:     isBlockCandidate,
            trustedShare:   isTrustedShare,
            poolID:         global.config.pool_id,
            timestamp:      time_now
        }));
    } else {
        for (let payout in miner.payout_div) {
            const payout_split   = payout.split(".");
            const paymentAddress = payout_split[0];
            const paymentID      = payout_split.length === 2 ? payout_split[1] : null;
            const payoutPercent  = miner.payout_div[payout];
            const shares         = share_reward * payoutPercent / 100;
            const shares2        = Math.floor(share_reward2 * payoutPercent / 100);
            global.database.storeShare(bt_height, global.protos.Share.encode({
                paymentAddress: paymentAddress,
                paymentID:      paymentID,
                raw_shares:     shares,
                shares2:        shares2,
                share_num:      share_num,
                identifier:     worker_name,
                port:           bt_port,
                blockHeight:    bt_height,
                blockDiff:      bt_difficulty,
                poolType:       miner.poolTypeEnum,
                bitcoin:        miner.bitcoin,
                foundBlock:     isBlockCandidate,
                trustedShare:   isTrustedShare,
                poolID:         global.config.pool_id,
                timestamp:      time_now
            }));
        }
    }
}

function walletAccFinalizer(wallet_key, miner, bt_port) {
    debug("!!! " + wallet_key + ": scanning for old worker names");
    let wallet = walletAcc[wallet_key];
    let is_something_left = false;
    let time_now = Date.now();
    for (let worker_name in wallet) {
        let worker = wallet[worker_name];
        if (time_now - worker.time > 60*1000) {
            let acc = worker.acc;
            if (acc != 0) {
                let height = worker.height;
                debug("!!! " + wallet_key + " / " + worker_name  + ": storing old worker share " + height + " " + worker.difficulty + " " + time_now + " " + acc);
                storeShareDiv(miner, acc, worker.acc2, worker.share_num, worker_name, bt_port, height, worker.difficulty, false, true);
            }
            debug("!!! " + wallet_key + ": removing old worker " + worker_name);
            if (worker_name !== "all_other_workers") -- walletWorkerCount[wallet_key];
            delete wallet[worker_name];
        } else {
            is_something_left = true;
        }
    }

    if (is_something_left) {
        setTimeout(walletAccFinalizer, 60*1000, wallet_key, miner, bt_port);
    } else {
        is_walletAccFinalizer[wallet_key] = false;
    }
}

function recordShareData(miner, job, isTrustedShare, blockTemplate) {
    miner.hashes += job.norm_diff;
    let proxyMinerName = miner.payout; // + ":" + miner.identifier;
    if (proxyMinerName in proxyMiners) proxyMiners[proxyMinerName].hashes += job.norm_diff;

    const time_now = Date.now();
    let wallet_key = miner.wallet_key + blockTemplate.port;

    if (!(wallet_key in walletAcc)) {
        walletAcc[wallet_key] = {};
        walletWorkerCount[wallet_key] = 0;
        is_walletAccFinalizer[wallet_key] = false;
    }

    const db_job_height = global.config.daemon.port == blockTemplate.port ? blockTemplate.height : anchorBlockHeight;

    let wallet = walletAcc[wallet_key];
    const worker_name = miner.identifier in wallet || walletWorkerCount[wallet_key] < 50 ? miner.identifier : "all_other_workers";
    
    if (!(worker_name in wallet)) {
        if (worker_name !== "all_other_workers") ++ walletWorkerCount[wallet_key];
        debug("!!! " + wallet_key + ": adding new worker " + worker_name + " (num " + walletWorkerCount[wallet_key] + ")");
        wallet[worker_name] = {};
        let worker = wallet[worker_name];
        worker.height     = db_job_height;
        worker.difficulty = blockTemplate.difficulty;
        worker.time       = time_now;
        worker.acc        = 0;
        worker.acc2       = 0;
        worker.share_num  = 0;
    }
    
    let worker = wallet[worker_name];
    
    let height     = worker.height;
    let difficulty = worker.difficulty;
    let acc        = worker.acc;
    let acc2       = worker.acc2;
    let share_num  = worker.share_num;
    
    if (height !== db_job_height || difficulty !== blockTemplate.difficulty || time_now - worker.time > 60*1000 || acc >= 100000000) {
        if (acc != 0) {
            debug("!!! " + wallet_key + " / " + worker_name  + ": storing share " + height + " " + difficulty + " " + time_now + " " + acc);
            storeShareDiv(miner, acc, acc2, share_num, worker_name, blockTemplate.port, height, difficulty, false, isTrustedShare);
        }
    
        worker.height     = db_job_height;
        worker.difficulty = blockTemplate.difficulty;
        worker.time       = time_now;
        worker.acc        = job.rewarded_difficulty;
        worker.acc2       = job.rewarded_difficulty2;
        worker.share_num  = 1;
    
    } else {
        worker.acc  += job.rewarded_difficulty;
        worker.acc2 += job.rewarded_difficulty2;
        ++ worker.share_num;
    }
    
    debug("!!! " + wallet_key + " / " + worker_name  + ": accumulating share " + db_job_height + " " + blockTemplate.difficulty + " " + worker.time + " " + worker.acc + " (+" +  job.rewarded_difficulty + ")");

    if (is_walletAccFinalizer[wallet_key] === false) {
        is_walletAccFinalizer[wallet_key] = true;
        setTimeout(walletAccFinalizer, 60*1000, wallet_key, miner, blockTemplate.port);
    }

    if (isTrustedShare) {
        process.send({type: 'trustedShare'});
        debug(threadName + "Accepted trusted share at difficulty: " + job.difficulty + "/" + job.rewarded_difficulty + " from: " + miner.logString);
    } else {
        process.send({type: 'normalShare'});
        debug(threadName + "Accepted valid share at difficulty: " + job.difficulty + "/" + job.rewarded_difficulty + " from: " + miner.logString);
    }
    if (activeBlockTemplates[job.coin].idHash !== blockTemplate.idHash) {
        process.send({type: 'outdatedShare'});
    }

}

function getShareBuffer(miner, job, blockTemplate, params) {
    try {
        let template = new Buffer(blockTemplate.buffer.length);
        blockTemplate.buffer.copy(template);
        template.writeUInt32BE(job.extraNonce, blockTemplate.reserved_offset);
        if (miner.proxy) {
            template.writeUInt32BE(params.poolNonce,   job.clientPoolLocation);
            template.writeUInt32BE(params.workerNonce, job.clientNonceLocation);
        }
        return global.coinFuncs.constructNewBlob(template, params, blockTemplate.port);
    } catch (e) {
        const err_str = "Can't constructNewBlob of " + blockTemplate.port + " port with " + JSON.stringify(params) + " params from " + miner.logString + ": " + e;
        console.error(err_str);
        global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't constructNewBlob", err_str);
        return null;
    }
}


function invalid_share(miner) {
    process.send({type: 'invalidShare'});
    miner.sendSameCoinJob();
    walletTrust[miner.payout] = 0;
    return false;
}

function submit_block(miner, job, blockTemplate, blockData, resultBuff, isTrustedShare, isParentBlock, isRetrySubmitBlock, submit_blockCB) {
    let reply_fn = function (rpcResult, rpcStatus) {
        const blockDataStr = Buffer.isBuffer(blockData) ? blockData.toString('hex') : JSON.stringify(blockData);
        if (rpcResult && (rpcResult.error || rpcResult.result === "high-hash")) { // did not manage to submit a block
            let isNotifyAdmin = true;
            if (isParentBlock && isTrustedShare) {
                const convertedBlob = global.coinFuncs.convertBlob(blockData, blockTemplate.port);
                const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
                if (!buff.equals(resultBuff)) isNotifyAdmin = false;
            }

            console.error(threadName + "Error submitting " + blockTemplate.coin + " (port " + blockTemplate.port + ") block at height " +
                blockTemplate.height + " (active block template height: " + activeBlockTemplates[blockTemplate.coin].height + ") from " +
                miner.logString + ", isTrustedShare: " + isTrustedShare + ", valid: " + isNotifyAdmin + ", rpcStatus: " + rpcStatus +
                ", error: " + JSON.stringify(rpcResult) + ", block hex: \n" + blockDataStr
            );

            if (isNotifyAdmin) setTimeout(function() { // only alert if block height is not changed in the nearest time
                global.coinFuncs.getPortLastBlockHeader(blockTemplate.port, function(err, body) {
                    if (err !== null) {
                        console.error("Last block header request failed for " + blockTemplate.port + " port!");
                        return;
                    }
                    if (blockTemplate.height == body.height + 1) global.support.sendEmail(global.config.general.adminEmail,
                        "FYI: Can't submit " + blockTemplate.coin + " block to deamon on " + blockTemplate.port + " port",
                        "The pool server: " + global.config.hostname + " can't submit block to deamon on " + blockTemplate.port + " port\n" +
                        "Input: " + blockDataStr + "\n" +
                        threadName + "Error submitting " + blockTemplate.coin + " block at " + blockTemplate.height + " height from " + miner.logString +
                        ", isTrustedShare: " + isTrustedShare + " error ): " + JSON.stringify(rpcResult)
                    );
               });
            }, 2*1000);

            if (global.config.pool.trustedMiners) {
                debug(threadName + "Share trust broken by " + miner.logString);
                miner.trust.trust         = 0;
                walletTrust[miner.payout] = 0;
            }

            if (submit_blockCB) submit_blockCB(false);

        // Success! Submitted a block without an issue.
        } else if (   rpcResult && (
                          typeof(rpcResult.result) !== 'undefined' ||
                          ( typeof rpcResult === 'string' && rpcStatus == 202 && blockTemplate.port == 11898 )
                      )
                  ) {

            let newBlockHash;
            const blob_type_num = global.coinFuncs.portBlobType(blockTemplate.port, blockTemplate.block_version);
            if (global.coinFuncs.blobTypeDero(blob_type_num)) {
                newBlockHash = rpcResult.result.blid;
            } else if (global.coinFuncs.blobTypeRaven(blob_type_num)) {
                newBlockHash = resultBuff.toString('hex');
            } else if (global.coinFuncs.blobTypeEth(blob_type_num)) {
                newBlockHash = rpcResult.result.substr(2);
            } else {
                newBlockHash = global.coinFuncs.getBlockID(blockData, blockTemplate.port).toString('hex');
            }

            console.log(threadName + "New " + blockTemplate.coin + " (port " + blockTemplate.port + ") block " + newBlockHash + " found at height " + blockTemplate.height + " by " + miner.logString +
                ", isTrustedShare: " + isTrustedShare + " - submit result: " + JSON.stringify(rpcResult) +
                ", block hex: \n" + blockDataStr
            );

            const time_now = Date.now();
            if (global.config.daemon.port == blockTemplate.port) {
                global.database.storeBlock(blockTemplate.height, global.protos.Block.encode({
                    hash:       newBlockHash,
                    difficulty: blockTemplate.difficulty,
                    shares:     0,
                    timestamp:  time_now,
                    poolType:   miner.poolTypeEnum,
                    unlocked:   false,
                    valid:      true
                }));
            } else {
                global.database.storeAltBlock(Math.floor(time_now / 1000), global.protos.AltBlock.encode({
                    hash:          newBlockHash,
                    difficulty:    blockTemplate.difficulty,
                    shares:        0,
                    timestamp:     time_now,
                    poolType:      miner.poolTypeEnum,
                    unlocked:      false,
                    valid:         true,
                    port:          blockTemplate.port,
                    height:        blockTemplate.height,
                    anchor_height: anchorBlockHeight
                }));
            }

            if (submit_blockCB) submit_blockCB(true);

        } else { // something not expected happened
            if (isRetrySubmitBlock) {
                console.error(threadName + "Unknown error submitting " + blockTemplate.coin + " (port " + blockTemplate.port + ") block at height " +
                    blockTemplate.height + " (active block template height: " + activeBlockTemplates[blockTemplate.coin].height + ") from " +
                    miner.logString + ", isTrustedShare: " + isTrustedShare + ", rpcStatus: " + rpcStatus + ", error (" + (typeof rpcResult) + "): " + JSON.stringify(rpcResult) +
                    ", block hex: \n" + blockDataStr
                );
                setTimeout(submit_block, 500, miner, job, blockTemplate, blockData, resultBuff, isTrustedShare, isParentBlock, false, submit_blockCB);
            } else {
                // RPC bombed out massively.
                console.error(threadName + "RPC Error. Please check logs for details");
                global.support.sendEmail(global.config.general.adminEmail,
                    "FYI: Can't submit block to deamon on " + blockTemplate.port + " port",
                    "Input: " + blockDataStr + "\n" +
                    "The pool server: " + global.config.hostname + " can't submit block to deamon on " + blockTemplate.port + " port\n" +
                    "RPC Error. Please check logs for details"
                );
                if (submit_blockCB) submit_blockCB(false);
            }
        }
    };

    if (blockTemplate.port == 11898) {
        global.support.rpcPortDaemon2(blockTemplate.port, "block", blockData.toString('hex'), reply_fn);
    } else if (global.coinFuncs.blobTypeRaven(job.blob_type_num)) {
        global.support.rpcPortDaemon2(blockTemplate.port, "", { method: "submitblock", params: [ blockData.toString('hex') ] }, reply_fn);
    } else if (global.coinFuncs.blobTypeEth(job.blob_type_num)) {
        global.support.rpcPortDaemon2(blockTemplate.port, "", { method: "parity_submitWorkDetail", params: blockData, jsonrpc: "2.0", id: 0 }, reply_fn);
    } else if (global.coinFuncs.blobTypeDero(job.blob_type_num)) {
        global.support.rpcPortDaemon(blockTemplate.port, "submitblock", [ blockTemplate.blocktemplate_blob, blockData.toString('hex') ], reply_fn);
    } else {
        global.support.rpcPortDaemon(blockTemplate.port, "submitblock", [ blockData.toString('hex') ], reply_fn);
    }
}

// wallets that need extra share verification
let extra_wallet_verify = {};
let extra_verify_wallet_hashes = [];

function is_safe_to_trust(reward_diff, miner_wallet, miner_trust) {
    const reward_diff2 = reward_diff * global.config.pool.trustThreshold;
    return reward_diff < 400000 && miner_trust != 0 && (
        (   miner_wallet in walletTrust &&
            reward_diff2 * global.config.pool.trustThreshold < walletTrust[miner_wallet] &&
            crypto.randomBytes(1).readUIntBE(0, 1) > global.config.pool.trustMin
        ) || (
            reward_diff2 < miner_trust &&
            crypto.randomBytes(1).readUIntBE(0, 1) > Math.max(256 - miner_trust / reward_diff / 2, global.config.pool.trustMin)
        )
    );
}

function hashBuffDiff(hash) { // bignum as result
    return baseDiff.div(bignum.fromBuffer(hash, {endian: 'little', size: 32}));
}

function hashRavenBuffDiff(hash) { // float as result
    return baseRavenDiff / bignum.fromBuffer(hash).toNumber();
}

function hashEthBuffDiff(hash) { // bignum as result
    return baseDiff.div(bignum.fromBuffer(hash));
}

// will work for numbers and bignum 
function ge(l, r) {
    if (typeof l === 'object') return l.ge(r);
    if (typeof r === 'object') return !r.lt(l);
    return l >= r;
}

function report_miner_share(miner, job) {
    const time_now = Date.now();
    if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 30*1000) {
        console.error(threadName + "Bad share from miner (diff " + job.difficulty + ") " + miner.logString);
        lastMinerLogTime[miner.payout] = time_now;
    }
}

function processShare(miner, job, blockTemplate, params, processShareCB) {
    const port          = blockTemplate.port;
    const blob_type_num = job.blob_type_num;

    if (miner.payout in minerWallets) minerWallets[miner.payout].hashes += job.norm_diff;
    walletLastSeeTime[miner.payout] = Date.now();

    let shareThrottled = function() {
        if (miner.payout in minerWallets && ++minerWallets[miner.payout].last_ver_shares >= MAX_VER_SHARES_PER_SEC * VER_SHARES_PERIOD) {
            if (minerWallets[miner.payout].last_ver_shares === MAX_VER_SHARES_PER_SEC * VER_SHARES_PERIOD) {
                console.error(threadName + "Throttled down miner share (diff " + job.rewarded_difficulty2 + ") submission from " + miner.logString);
            }
            process.send({type: 'throttledShare'});
            addProxyMiner(miner);
            const proxyMinerName = miner.payout; // + ":" + miner.identifier;
            proxyMiners[proxyMinerName].hashes += job.norm_diff;
            adjustMinerDiff(miner);
            return true;
        }
        return false;
    }

    let verifyShare = function(verifyShareCB) {
        if (global.coinFuncs.blobTypeGrin(blob_type_num)) {
            const blockData = getShareBuffer(miner, job, blockTemplate, params);
            if (blockData === null) return processShareCB(invalid_share(miner));
            const header = Buffer.concat([global.coinFuncs.convertBlob(blockData, port), bignum(params.nonce, 10).toBuffer({endian: 'big', size: 4})]);
            if (global.coinFuncs.c29(header, params.pow, port)) {
                report_miner_share(miner, job);
                return processShareCB(invalid_share(miner));
            }
            const resultBuff = global.coinFuncs.c29_cycle_hash(params.pow, blob_type_num);
            return verifyShareCB(hashBuffDiff(resultBuff), resultBuff, blockData, false, true);

        } else if (global.coinFuncs.blobTypeRaven(blob_type_num)) {
            const blockData = getShareBuffer(miner, job, blockTemplate, params);
            if (blockData === null) return processShareCB(invalid_share(miner));
            const convertedBlob = global.coinFuncs.convertBlob(blockData, port);
            if (params.header_hash !== convertedBlob.toString("hex")) {
                console.error("Wrong header hash:" + params.header_hash + " " + convertedBlob.toString("hex"));
                report_miner_share(miner, job);
                return processShareCB(invalid_share(miner));
            }
            const resultBuff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate, params.nonce, params.mixhash);
            return verifyShareCB(hashRavenBuffDiff(resultBuff), resultBuff, blockData, false, true);

        } else if (global.coinFuncs.blobTypeEth(blob_type_num)) {
            if (shareThrottled()) return processShareCB(null);
            const hashes = global.coinFuncs.slowHashBuff(Buffer.from(blockTemplate.hash, 'hex'), blockTemplate, params.nonce);
            const resultBuff = hashes[0];
            const blockData = [ "0x" + params.nonce, "0x" + blockTemplate.hash, "0x" + hashes[1].toString('hex') ];
            return verifyShareCB(hashEthBuffDiff(resultBuff), resultBuff, blockData, false, true);
        }

        const resultHash = params.result;
        let resultBuff;
        try {
            resultBuff = Buffer.from(resultHash, 'hex');
        } catch(e) {
            return processShareCB(invalid_share(miner));
        }
        const hashDiff = hashBuffDiff(resultBuff);

        if ( global.config.pool.trustedMiners &&
             is_safe_to_trust(job.rewarded_difficulty2, miner.payout, miner.trust.trust) &&
             miner.trust.check_height !== job.height
           ) {
            let blockData = null;
            if (miner.payout in extra_wallet_verify) {
                blockData = getShareBuffer(miner, job, blockTemplate, params);
                if (blockData !== null) {
                    const convertedBlob = global.coinFuncs.convertBlob(blockData, port);
		    global.coinFuncs.slowHashAsync(convertedBlob, blockTemplate, function(hash) {
                        if (hash === null || hash === false) {
                            console.error(threadName + "[EXTRA CHECK] Can't verify share remotely!");
                        } else if (hash !== resultHash) {
                            console.error(threadName + miner.logString + " [EXTRA CHECK] INVALID SHARE OF " + job.rewarded_difficulty2 + " REWARD HASHES");
                        } else {
                            extra_verify_wallet_hashes.push(miner.payout + " " + convertedBlob.toString('hex') + " " + resultHash + " " + global.coinFuncs.algoShortTypeStr(port) + " " + blockTemplate.height + " " + blockTemplate.seed_hash);
                        }
                    });
                } else {
                    console.error(threadName + miner.logString + " [EXTRA CHECK] CAN'T MAKE SHARE BUFFER");
                }
            }
            if (miner.lastSlowHashAsyncDelay) {
                setTimeout(function() { return verifyShareCB(hashDiff, resultBuff, blockData, true, true); }, miner.lastSlowHashAsyncDelay);
                debug("[MINER] Delay " + miner.lastSlowHashAsyncDelay);
            } else {
                return verifyShareCB(hashDiff, resultBuff, blockData, true, true);
            }

        } else { // verify share
            if (miner.debugMiner) console.log(threadName + miner.logString + " [WALLET DEBUG] verify share");
            if (shareThrottled()) return processShareCB(null);
            const blockData = getShareBuffer(miner, job, blockTemplate, params);
            if (blockData === null) return processShareCB(invalid_share(miner));
            const convertedBlob = global.coinFuncs.convertBlob(blockData, port);

            const isBlockDiffMatched = ge(hashDiff, blockTemplate.difficulty);
            if (isBlockDiffMatched) {
                if (miner.validShares || (miner.payout in minerWallets && minerWallets[miner.payout].hashes)) {
                    submit_block(miner, job, blockTemplate, blockData, resultBuff, true, true, true, function(block_submit_result) {
                        if (!block_submit_result) {
                            const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
                            if (!buff.equals(resultBuff)) {
                                report_miner_share(miner, job);
                                return processShareCB(invalid_share(miner));
                            }
                        }
                        walletTrust[miner.payout] += job.rewarded_difficulty2;
                        return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
                    });
               } else {
                    const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
                    if (!buff.equals(resultBuff)) {
                        report_miner_share(miner, job);
                        return processShareCB(invalid_share(miner));
                    }
                    walletTrust[miner.payout] += job.rewarded_difficulty2;
                    return verifyShareCB(hashDiff, resultBuff, blockData, false, true);
               }
            } else {
                const time_now = Date.now();
                global.coinFuncs.slowHashAsync(convertedBlob, blockTemplate, function(hash) {
                    if (hash === null) {
                        return processShareCB(null);
                    } else if (hash === false) {
                        console.error(threadName + "Processed share locally instead of remotely!");
                        hash = global.coinFuncs.slowHash(convertedBlob, blockTemplate);
                    }
                    if (hash !== resultHash) {
                        report_miner_share(miner, job);
                        return processShareCB(invalid_share(miner));
                    }
                    miner.lastSlowHashAsyncDelay = Date.now() - time_now;
                    if (miner.lastSlowHashAsyncDelay > 1000) miner.lastSlowHashAsyncDelay = 1000;
                    walletTrust[miner.payout] += job.rewarded_difficulty2;
                    return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
                });
            }
        }
    };

    verifyShare(function(hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff) {
        if (isNeedCheckBlockDiff && ge(hashDiff, blockTemplate.difficulty)) { // Submit block to the RPC Daemon.
            if (!blockData) {
                blockData = getShareBuffer(miner, job, blockTemplate, params);
                if (!blockData) return processShareCB(invalid_share(miner));
            }
            submit_block(miner, job, blockTemplate, blockData, resultBuff, isTrustedShare, true, true);
        }
    
        const is_mm = "child_template" in blockTemplate;
        if (is_mm && ge(hashDiff, blockTemplate.child_template.difficulty)) { // Submit child block to the RPC Daemon.
            if (!blockData) {
                blockData = getShareBuffer(miner, job, blockTemplate, params);
                if (!blockData) return processShareCB(invalid_share(miner));
            }
            // need to properly restore child template buffer here since it went via message string and was restored not correctly
            blockTemplate.child_template_buffer = Buffer.from(blockTemplate.child_template_buffer);
            let shareBuffer2 = null;
            try {
                shareBuffer2 = global.coinFuncs.constructMMChildBlockBlob(blockData, port, blockTemplate.child_template_buffer);
            } catch (e) {
                const err_str = "Can't construct_mm_child_block_blob with " + blockData.toString('hex') + " parent block and " + blockTemplate.child_template_buffer.toString('hex') + " child block share buffers from " + miner.logString + ": " + e;
                console.error(err_str);
                global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't construct_mm_child_block_blob", err_str);
                return processShareCB(invalid_share(miner));
            }
            if (shareBuffer2 === null) return processShareCB(invalid_share(miner));
            submit_block(miner, job, blockTemplate.child_template, shareBuffer2, resultBuff, isTrustedShare, false, true);
        }
    
        if (!ge(hashDiff, job.difficulty)) {
            let time_now = Date.now();
            if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 30*1000) {
               console.warn(threadName + "Rejected low diff (" + hashDiff + " < " + job.difficulty + ") share from miner " + miner.logString);
               lastMinerLogTime[miner.payout] = time_now;
            }
            return processShareCB(invalid_share(miner));
    
        } else {
            recordShareData(miner, job, isTrustedShare, blockTemplate);
            // record child proc share for rewarded_difficulty effort calcs status but with 0 rewards (all included in parent share)
            if (is_mm) {
                job.rewarded_difficulty2 = 0;
                recordShareData(miner, job, isTrustedShare, blockTemplate.child_template);
            }
            return processShareCB(true);
        }
   });
}

// Message times for different miner addresses
let lastMinerLogTime = {};
// Miner notification times
let lastMinerNotifyTime = {};

function get_miner_notification(payout) {
    if (payout in notifyAddresses) return notifyAddresses[payout];
    return false;
}

function handleMinerData(socket, id, method, params, ip, portData, sendReply, sendReplyFinal, pushMessage) {
    switch (method) {
        case 'mining.authorize': // Eth/Raven only
            if (!params || !(params instanceof Array)) {
                sendReplyFinal("No array params specified");
                return;
            }
            params = {
                login: params[0],
                pass:  params[1],
                agent: socket.eth_agent ? socket.eth_agent : "[generic_ethminer]",
                algo:  [ "kawpow" ],
                "algo-perf": { "kawpow": 1 },
            };
            // continue to normal login

        case 'login': { // Grin and default
            if (ip in bannedIPs) {
                sendReplyFinal("New connections from this IP address are temporarily suspended from mining (10 minutes max)");
                return;
            }
            if (!params) {
                sendReplyFinal("No params specified");
                return;
            }
            if (!params.login) {
                sendReplyFinal("No login specified");
                return;
            }
            if (!params.pass) params.pass = "x";
            const difficulty = portData.difficulty;
            const minerId = get_new_id();
            let miner = new Miner(
                minerId, params.login, params.pass, ip, difficulty, pushMessage, 1, portData.portType, portData.port, params.agent,
                params.algo, params["algo-perf"], params["algo-min-time"]
            );
            if (miner.debugMiner) socket.debugMiner = 1; //console.log(threadName + miner.logString + " [WALLET DEBUG] " + method + ": "  + JSON.stringify(params));
            if (method === 'mining.authorize') {
                const new_id = socket.eth_extranonce_id ? socket.eth_extranonce_id : get_new_eth_extranonce_id();
                if (new_id !== null) {
                    socket.eth_extranonce_id = new_id;
                    miner.eth_extranonce     = eth_extranonce(new_id);
                } else {
                    miner.valid_miner = false;
                    miner.error = "Not enough extranoces. Switch to other pool node.";
                }
            }
            if (params.agent && process.env['WORKER_ID'] == 1) minerAgents[params.agent] = 1;
            let time_now = Date.now();
            if (!miner.valid_miner) {
                if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 10*60*1000) {
                    console.log("Invalid miner " + miner.logString + " [" + miner.email + "], disconnecting due to: " + miner.error);
                    lastMinerLogTime[miner.payout] = time_now;
                }
                sendReplyFinal(miner.error);
                return;
            }

            const miner_agent_notification = !global.coinFuncs.algoMainCheck(miner.algos) && global.coinFuncs.algoPrevMainCheck(miner.algos) ?
                                             global.coinFuncs.get_miner_agent_warning_notification(params.agent) : false;
            const miner_notification = miner_agent_notification ? miner_agent_notification : get_miner_notification(miner.payout);
            if (miner_notification) {
                if (!(miner.payout in lastMinerNotifyTime) || time_now - lastMinerNotifyTime[miner.payout] > 60*60*1000) {
                    lastMinerNotifyTime[miner.payout] = time_now;
                    console.error("Sent notification to " + miner.logString + ": " + miner_notification);
                    sendReplyFinal(miner_notification + " (miner will connect after several attempts)");
                    return;
                }
            }

            if (!socket.miner_ids) socket.miner_ids = [];
            socket.miner_ids.push(minerId);
            activeMiners.set(minerId, miner);

            if (!miner.proxy) {
                let proxyMinerName = miner.payout; // + ":" + miner.identifier;
                if ((params.agent && params.agent.includes('proxy')) || (proxyMinerName in proxyMiners)) {
                    addProxyMiner(miner);
                    if (proxyMiners[proxyMinerName].hashes) adjustMinerDiff(miner);
                } else {
                    if (!(miner.payout in minerWallets)) {
                        minerWallets[miner.payout] = {};
                        minerWallets[miner.payout].connectTime = Date.now();
                        minerWallets[miner.payout].count = 1;
                        minerWallets[miner.payout].hashes = 0;
                        minerWallets[miner.payout].last_ver_shares = 0;
                    } else {
                        ++ minerWallets[miner.payout].count;
                    }
                }
            }
            if (id === "Stratum") { // if grin miner is connected directly to the pool
                sendReply(null, "ok");
                miner.protocol = "grin";
            } else if (method === 'mining.authorize') { // if raven/eth miner is connected directly to the pool
                sendReply(null, true);
                miner.protocol = "eth"; // technically equivalent to "default"
                miner.sendBestCoinJob();
            } else { // if meta-miner or xmrig or something else connected
                const coin = miner.selectBestCoin();
                if (coin !== false) {
                    const params = getCoinJobParams(coin);
                    const blob_type_num = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(coin));
                    if (global.coinFuncs.blobTypeRaven(blob_type_num) || global.coinFuncs.blobTypeEth(blob_type_num)) { // xmrig specifics
                        const new_id = socket.eth_extranonce_id ? socket.eth_extranonce_id : get_new_eth_extranonce_id();
                        if (new_id !== null) {
                            socket.eth_extranonce_id = new_id;
                            miner.eth_extranonce     = eth_extranonce(new_id);
                            sendReply(null, { id: minerId, algo: params.algo_name, extra_nonce: miner.eth_extranonce });
                            miner.sendCoinJob(coin, params);
                        } else {
                            sendReplyFinal("Not enough extranoces. Switch to other pool node.");
                        }
                    } else {
                        sendReply(null, { id: minerId, job: miner.getCoinJob(coin, params), status: 'OK' });
                    }
                } else {
                    sendReplyFinal("No block template yet. Please wait.");
                }
                miner.protocol = "default";
            }
            break;
        }

        case 'mining.subscribe': { // Raven/Eth only
            if (params && (params instanceof Array) && params.length >= 1) socket.eth_agent = params[0];
            const new_id = socket.eth_extranonce_id ? socket.eth_extranonce_id : get_new_eth_extranonce_id();
            if (new_id !== null) {
                socket.eth_extranonce_id = new_id;
                // extranonce is not really needed for Raven (extraonce is specificed as part of coinbase tx)
	        sendReply(null, [ [ "mining.notify", get_new_id(), "EthereumStratum/1.0.0" ], eth_extranonce(new_id) ]);
            } else {
                sendReplyFinal("Not enough extranoces. Switch to other pool node.");
            }
            break;
        }

        case 'mining.extranonce.subscribe': { // Raven/Eth only
	    sendReply(null, true);
            break;
        }

        case 'getjobtemplate': { // grin-mode miner only
            const minerId = socket.miner_ids && socket.miner_ids.length == 1 ? socket.miner_ids[0] : "";
            let miner = activeMiners.get(minerId);
            if (!miner) {
                sendReplyFinal('Unauthenticated');
                return;
            }
            miner.heartbeat();
            sendReply(null, miner.getBestCoinJob());
            break;
        }

        case 'getjob': {
            if (!params) {
                sendReplyFinal("No params specified");
                return;
            }
            let miner = activeMiners.get(params.id);
            if (!miner) {
                sendReplyFinal('Unauthenticated');
                return;
            }
            miner.heartbeat();
            if (params.algo && params.algo instanceof Array && params["algo-perf"] && params["algo-perf"] instanceof Object) {
                const status = miner.setAlgos(params.algo, params["algo-perf"], params["algo-min-time"]);
                if (status != "") {
                    sendReply(status);
                    return;
                }
            }
            sendReply(null, miner.getBestCoinJob());
            break;
        }

        case 'mining.submit':
            if (!params || !(params instanceof Array)) {
                sendReply("No array params specified");
                return;
            }

            for (const param of params) if (typeof param !== 'string') {
                sendReply("No correct params specified");
                return;
            }

            switch (params.length) {
                case 3: params = {
                    job_id:      params[1],
                    nonce:       params[2],
                }; break;

                case 5: params = {
                    job_id:      params[1],
                    nonce:       params[2].substr(2),
                    header_hash: params[3].substr(2),
                    mixhash:     params[4].substr(2),
                }; break;

                default:
                    sendReply("No correct params specified");
                    return;
            }


            // continue to normal login

        case 'submit': { // grin and default
            if (!params) {
                sendReplyFinal("No params specified");
                return;
            }
            const minerId = params.id ? params.id : (socket.miner_ids && socket.miner_ids.length == 1 ? socket.miner_ids[0] : "");
            let miner = activeMiners.get(minerId);
            if (!miner) {
                sendReplyFinal('Unauthenticated');
                return;
            }
            //if (miner.debugMiner) console.log("SUBMIT");
            miner.heartbeat();
            if (typeof (params.job_id) === 'number') params.job_id = params.job_id.toString(); // for grin miner

            let job = miner.validJobs.toarray().filter(function (job) {
                return job.id === params.job_id;
            })[0];

            if (!job) {
                sendReply('Invalid job id');
                return;
            }

            const blob_type_num = job.blob_type_num;
            const nonce_sanity_check = function(blob_type_num, params) {
                if (global.coinFuncs.blobTypeGrin(blob_type_num)) {
                    if (typeof params.nonce !== 'number') return false;
                    if (!(params.pow instanceof Array)) return false;
                    if (params.pow.length != global.coinFuncs.c29ProofSize(blob_type_num)) return false;
                } else {
                    if (typeof params.nonce !== 'string') return false;
                    if (global.coinFuncs.nonceSize(blob_type_num) == 8) {
                        const isEth = global.coinFuncs.blobTypeEth(blob_type_num);
                        if (isEth) params.nonce = job.extraNonce + params.nonce;
                        if (!nonceCheck64.test(params.nonce)) return false;
                        if (global.coinFuncs.blobTypeRaven(blob_type_num)) {
                            if (!hashCheck32.test(params.mixhash)) return false;
                            if (!hashCheck32.test(params.header_hash)) return false;
                        } else if (!isEth) {
                            if (!hashCheck32.test(params.result)) return false;
                        }
                    } else {
                        if (!nonceCheck32.test(params.nonce)) return false;
                        if (!hashCheck32.test(params.result)) return false;
                    }
                }
                return true;
            };
            if (!nonce_sanity_check(blob_type_num, params)) {
                console.warn(threadName + 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + miner.logString);
                miner.checkBan(false);
                sendReply('Duplicate share');
                miner.storeInvalidShare();
                return;
            }

            let nonce_test;

            if (miner.proxy) {
                if (!Number.isInteger(params.poolNonce) || !Number.isInteger(params.workerNonce)) {
                    console.warn(threadName + 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + miner.logString);
                    miner.checkBan(false);
                    sendReply('Duplicate share');
                    miner.storeInvalidShare();
                    return;
                }
                nonce_test = global.coinFuncs.blobTypeGrin(blob_type_num) ?
                             params.pow.join(':') + `_${params.poolNonce}_${params.workerNonce}` :
                             `${params.nonce}_${params.poolNonce}_${params.workerNonce}`;
            } else {
                nonce_test = global.coinFuncs.blobTypeGrin(blob_type_num) ? params.pow.join(':') : params.nonce;
            }

            if (nonce_test in job.submissions) {
                console.warn(threadName + 'Duplicate miner share with ' + nonce_test + ' nonce from ' + miner.logString);
                miner.checkBan(false);
                sendReply('Duplicate share');
                miner.storeInvalidShare();
                return;
            }
            job.submissions[nonce_test] = 1;

            let blockTemplate;
            job.rewarded_difficulty = job.difficulty;

            if (activeBlockTemplates[job.coin].idHash !== job.blockHash) {
                blockTemplate = pastBlockTemplates[job.coin].toarray().filter(function (t) {
                    return t.idHash === job.blockHash;
                })[0];
                let is_outdated = false;
                if (blockTemplate && blockTemplate.timeoutTime) {
                    const late_time = Date.now() - blockTemplate.timeoutTime;
                    if (late_time > 0) {
                        const max_late_time = global.config.pool.targetTime * 1000;
                        if (late_time < max_late_time) {
                            let factor = (max_late_time - late_time) / max_late_time;
                            job.rewarded_difficulty = job.difficulty * Math.pow(factor, 6); //Math.floor(job.difficulty * Math.pow(factor, 6));
                            //if (job.rewarded_difficulty === 0) job.rewarded_difficulty = 1;
                        } else {
                            is_outdated = true;
                        }
                    }
                }
                if (!blockTemplate || is_outdated) {
                    const err_str = is_outdated ? "Block outdated" : "Block expired";
                    const time_now = Date.now();
                    if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 30*1000) {
                        console.warn(threadName + err_str + ', Height: ' + job.height + ' (diff ' + job.difficulty + ') from ' + miner.logString);
                        lastMinerLogTime[miner.payout] = time_now;
                    }
                    miner.sendSameCoinJob();
                    sendReply(err_str);
                    miner.storeInvalidShare();
                    return;
                }
            } else {
                blockTemplate = activeBlockTemplates[job.coin];
                // kill miner if it mines block template for disabled coin for more than some time
                if (!lastCoinHashFactorMM[job.coin] && Date.now() - blockTemplate.timeCreated > 10*60*1000) {
                    sendReplyFinal("This algo was temporary disabled due to coin daemon issues. Consider using https://github.com/MoneroOcean/meta-miner to allow your miner auto algo switch in this case.");
                    return;
                }
            }

            job.rewarded_difficulty2 = job.rewarded_difficulty * job.coinHashFactor;
            //job.rewarded_difficulty = Math.floor(job.rewarded_difficulty);
            //if (job.rewarded_difficulty === 0) job.rewarded_difficulty = 1;

            processShare(miner, job, blockTemplate, params, function(shareAccepted) {
                if (miner.removed_miner) return;
                if (shareAccepted === null) {
                    sendReply('Throttled down share submission (please increase difficulty)');
                    return;
                }
                miner.checkBan(shareAccepted);

                if (global.config.pool.trustedMiners) {
                    if (shareAccepted) {
                        miner.trust.trust += job.rewarded_difficulty2;
                        miner.trust.check_height = 0;
                    } else {
                        debug(threadName + "Share trust broken by " + miner.logString);
                        miner.storeInvalidShare();
                        miner.trust.trust = 0;
                    }
                }

                if (!shareAccepted) {
                    sendReply('Low difficulty share');
                    return;
                }

                miner.lastShareTime = Date.now() / 1000 || 0;

                if (miner.protocol === "grin") {
                    sendReply(null, "ok");
                } else if (global.coinFuncs.blobTypeRaven(blob_type_num) || global.coinFuncs.blobTypeEth(blob_type_num)) {
                    sendReply(null, true);
                } else {
                    sendReply(null, { status: 'OK' });
                }
                //if (miner.debugMiner) console.log("SUBMIT OK");
            });
            break;
        }

        case 'keepalive':
        case 'keepalived': {
            if (!params) {
                sendReplyFinal("No params specified");
                return;
            }
            const minerId = params.id ? params.id : (socket.miner_ids && socket.miner_ids.length == 1 ? socket.miner_ids[0] : "");
            let miner = activeMiners.get(minerId);
            if (!miner) {
                sendReplyFinal('Unauthenticated');
                return;
            }
            miner.heartbeat();
            sendReply(null, { status: 'KEEPALIVED' });
            break;
        }
    }
}

if (global.config.general.allowStuckPoolKill && fs.existsSync("block_template_is_stuck")) {
   console.error("Stuck block template was detected on previous run. Please fix monerod and remove block_template_is_stuck file after that. Exiting...");
   setTimeout(function() { process.exit(); }, 5*1000);
   return;
}

setInterval(function dump_vars() {
   const fn = "dump" + (cluster.isMaster ? "" : "_" + process.env['WORKER_ID'].toString());
   fs.access(fn, fs.F_OK, function(err) {
      if (!err) return;
      console.log("DUMPING VARS TO " + fn + " FILE");
      let s = fs.createWriteStream(fn, {'flags': 'a'});

      s.write("activeMiners:\n");
      for (var [minerId, miner] of activeMiners) s.write(minerId + ": " + JSON.stringify(miner, null, '\t') + "\n");

      s.write("\n\n\npastBlockTemplates:\n");
      s.write(JSON.stringify(pastBlockTemplates, null, '\t') + "\n");

      s.write("\n\n\nlastBlockHash:\n");
      s.write(JSON.stringify(lastBlockHash, null, '\t') + "\n");

      s.write("\n\n\nlastCoinHashFactor:\n");
      s.write(JSON.stringify(lastCoinHashFactor, null, '\t') + "\n");

      s.write("\n\n\nnewCoinHashFactor:\n");
      s.write(JSON.stringify(newCoinHashFactor, null, '\t') + "\n");

      s.write("\n\n\nlastCoinHashFactorMM:\n");
      s.write(JSON.stringify(lastCoinHashFactorMM, null, '\t') + "\n");

      s.write("\n\n\nactiveBlockTemplates:\n");
      s.write(JSON.stringify(activeBlockTemplates, null, '\t') + "\n");

      s.write("\n\n\nproxyMiners:\n");
      s.write(JSON.stringify(proxyMiners, null, '\t') + "\n");

      s.write("\n\n\nanchorBlockHeight: " + anchorBlockHeight + "\n");
      s.write("\n\n\nanchorBlockPrevHeight: " + anchorBlockPrevHeight + "\n");

      s.write("\n\n\nwalletTrust:\n");
      s.write(JSON.stringify(walletTrust, null, '\t') + "\n");

      s.write("\n\n\nwalletLastSeeTime:\n");
      s.write(JSON.stringify(walletLastSeeTime, null, '\t') + "\n");

      s.write("\n\n\nwalletAcc:\n");
      s.write(JSON.stringify(walletAcc, null, '\t') + "\n");

      s.write("\n\n\nwalletWorkerCount:\n");
      s.write(JSON.stringify(walletWorkerCount, null, '\t') + "\n");

      s.write("\n\n\nis_walletAccFinalizer:\n");
      s.write(JSON.stringify(is_walletAccFinalizer, null, '\t') + "\n");

      s.end();
   });
}, 60*1000);

let master_cluster_worker_id_map = {};

function getUniqueWorkerID(cb) {
    global.mysql.query("SELECT id FROM pool_workers WHERE pool_id = ? AND worker_id = ?", [global.config.pool_id, process.env['WORKER_ID']]).then(function (rows) {
        if (rows.length === 0) {
            global.mysql.query("INSERT INTO pool_workers (pool_id, worker_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=id", [global.config.pool_id, process.env['WORKER_ID']]).then(function() {
                return getUniqueWorkerID(cb);
            }).catch(function(err) {
                console.error("Can't register unique pool worker for " + global.config.pool_id + " pool_id and " + process.env['WORKER_ID'] + " worker_id");
                process.exit(1);
            });
        } else if (rows.length !== 1) {
            console.error("Can't get unique pool worker for " + global.config.pool_id + " pool_id and " + process.env['WORKER_ID'] + " worker_id");
            process.exit(1);
        }
        global.mysql.query("SELECT MAX(id) as maxId FROM pool_workers").then(function (rows_max) {
            if (rows_max.length !== 1) {
                console.error("Can't get max id from pool_workers table");
                process.exit(1);
            }
            return cb(rows[0].id, rows_max[0].maxId);
        });
    });
}

if (cluster.isMaster) {
    const numWorkers = require('os').cpus().length;
    for (let i = 1; i <= numWorkers; ++ i) {
        minerCount[i] = [];
        global.config.ports.forEach(function (portData) {
            minerCount[i][portData.port] = 0;
        });
    }
    registerPool();

    setInterval(function () {
        if ("" in activeBlockTemplates) {
            global.mysql.query("UPDATE pools SET last_checkin = ?, active = ?, blockIDTime = now(), blockID = ?, port = ? WHERE id = ?", [global.support.formatDate(Date.now()), true, activeBlockTemplates[""].height, activeBlockTemplates[""].port, global.config.pool_id]);
        } else {
            global.mysql.query("UPDATE pools SET last_checkin = ?, active = ? WHERE id = ?", [global.support.formatDate(Date.now()), true, global.config.pool_id]);
        }
        global.config.ports.forEach(function (portData) {
            let miner_count = 0;
            for (let i = 1; i <= numWorkers; ++ i) miner_count += minerCount[i][portData.port];
            global.mysql.query("UPDATE ports SET lastSeen = now(), miners = ? WHERE pool_id = ? AND network_port = ?", [miner_count, global.config.pool_id, portData.port]);
        });
    }, 30*1000);


    setInterval(function () {
        if (!("" in activeBlockTemplates)) return;

        global.mysql.query("SELECT blockID, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)").then(function (rows) {
            let top_height = 0;
            const port   = activeBlockTemplates[""].port;
            const height = activeBlockTemplates[""].height;
            rows.forEach(function (row) {
                if (row.port != port) return;
                if (row.blockID > top_height) top_height = row.blockID;
            });
            if (top_height) {
               if (height < top_height - 3) {
                   console.error("!!! Current block height " + height + " is stuck compared to top height (" + top_height + ") amongst other leaf nodes for " + port + " port");
                   if (!(port in lastBlockFixTime)) lastBlockFixTime[port] = Date.now();

                   if (Date.now() - lastBlockFixTime[port] > 5*60*1000) {
                       if (!(port in lastBlockFixCount)) lastBlockFixCount[port] = 1;
                       else ++ lastBlockFixCount[port];

                       if (lastBlockFixCount[port] > 5 && global.config.general.allowStuckPoolKill && port == global.config.daemon.port) {
                           global.support.sendEmail(global.config.general.adminEmail,
                               "Pool server " + global.config.hostname + " will be terminated",
                               "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " will be terminated due to main chain block template stuck"
                           );
                           console.error("Block height was not updated for a long time for main port. Check your monerod. Exiting...");
                           fs.closeSync(fs.openSync("block_template_is_stuck", 'w'));
                           setTimeout(function() { process.exit(); }, 30*1000); // need time for admin email sending
                           return;
                       }

                       global.coinFuncs.fixDaemonIssue(height, top_height, port);
                       lastBlockFixTime[port] = Date.now();
                   }
               } else {
                   if (height >= top_height + 3) {
                       console.warn("Current block height " + height + " is somehow greater than top height (" + top_height + ") amongst other leaf nodes for " + port + " port");
                   }
                   lastBlockFixTime[port] = Date.now();
                   lastBlockFixCount[port] = 0;
               }
            } else {
               console.error("Can't get top height amongst all leaf nodes for " + port + " port");
               lastBlockFixTime[port] = Date.now();
               lastBlockFixCount[port] = 0;
            }
        });
    }, 60*1000);

    console.log('Master cluster setting up ' + numWorkers + ' workers...');

    for (let i = 0; i < numWorkers; i++) {
        let worker = cluster.fork({ WORKER_ID: master_cluster_worker_id_map[i + 1] = i + 1 });
        worker.on('message', messageHandler);
    }

    cluster.on('online', function (worker) {
        console.log('Worker ' + worker.process.pid + ' is online');
    });

    cluster.on('exit', function (worker, code, signal) {
        console.error('Worker ' + worker.process.pid + ' died with code: ' + code + ', and signal: ' + signal);
        console.log('Starting a new worker');
        const prev_worker_id = master_cluster_worker_id_map[worker.id];
        delete master_cluster_worker_id_map[worker.id];
        worker = cluster.fork({ WORKER_ID: prev_worker_id });
        master_cluster_worker_id_map[worker.id] = prev_worker_id;
        worker.on('message', messageHandler);
        global.support.sendEmail(global.config.general.adminEmail, "FYI: Started new worker " + prev_worker_id,
            "Hello,\r\nMaster thread of " + global.config.hostname + " starts new worker with id " + prev_worker_id);
    });


    newCoinHashFactor[""] = lastCoinHashFactor[""] = lastCoinHashFactorMM[""] = 1;
    templateUpdate("");
    setTimeout(templateUpdate, DAEMON_POLL_MS, "", true);

    if (global.config.daemon.enableAlgoSwitching) {
        if (global.config.daemon.enableAlgoSwitching) COINS.forEach(function(coin) {
            newCoinHashFactor[coin] = lastCoinHashFactor[coin] = lastCoinHashFactorMM[coin] = 0;
            setInterval(updateCoinHashFactor, 5*1000, coin);
            templateUpdate(coin);
            setTimeout(templateUpdate, DAEMON_POLL_MS, coin, true);
        });
    } else {
        console.warn("global.config.daemon.enableAlgoSwitching is not enabled");
    }

    global.support.sendEmail(global.config.general.adminEmail, "Pool server " + global.config.hostname + " online", "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " is online");

    let block_notify_server = net.createServer(function (socket) {
        let timer = setTimeout(function() {
            console.error(threadName + "Timeout waiting for block notify input");
            socket.destroy();
        }, 3*1000);
        let buff = "";
        socket.on('data', function (buff1) {
            buff += buff1;
        });
        socket.on('end', function () {
            clearTimeout(timer);
            timer = null;
            const port = parseInt(buff.toString());
            const coin = global.coinFuncs.PORT2COIN(port);
            if (typeof(coin) === 'undefined') {
                console.error(threadName + "Block notify for unknown coin with " + port + " port");
            } else {
                //console.log(threadName + "Block notify for coin " + coin + " with " + port + " port");
                templateUpdate(coin, false);
            }
        });
        socket.on('error', function() {
            console.error(threadName + "Socket error on block notify port");
            socket.destroy();
        });
    });

    block_notify_server.listen(BLOCK_NOTIFY_PORT, "127.0.0.1", function() {
        console.log(threadName + "Block notify server on " + BLOCK_NOTIFY_PORT + " port started");
    });

} else getUniqueWorkerID(function(id, maxId) {
    uniqueWorkerId = id;
    uniqueWorkerIdBits = 0;
    while (maxId) { maxId >>= 1; ++ uniqueWorkerIdBits; }
    freeEthExtranonces = [...Array(1 << (16 - uniqueWorkerIdBits)).keys()];
    console.log(threadName + "Starting pool worker with " + uniqueWorkerId + " unique id and " + uniqueWorkerIdBits + " reserved bits");

    newCoinHashFactor[""] = lastCoinHashFactor[""] = lastCoinHashFactorMM[""] = 1;
    templateUpdate("");
    if (global.config.daemon.enableAlgoSwitching) COINS.forEach(function(coin) {
        newCoinHashFactor[coin] = lastCoinHashFactor[coin] = lastCoinHashFactorMM[coin] = 0;
        templateUpdate(coin);
    });
    anchorBlockUpdate();
    setInterval(anchorBlockUpdate, 3*1000);
    setInterval(checkAliveMiners, 60*1000);
    setInterval(retargetMiners, global.config.pool.retargetTime * 1000);
    setInterval(function () {
        bannedIPs = {};
    }, 10*60*1000);

    function add_bans(is_show) {
        global.mysql.query("SELECT mining_address, reason FROM bans").then(function (rows) {
            bannedAddresses = {};
            rows.forEach(function (row) {
                bannedAddresses[row.mining_address] = row.reason;
                if (is_show) console.log("Added blocked address " + row.mining_address + ": " + row.reason);
            });
        });
        global.mysql.query("SELECT mining_address, message FROM notifications").then(function (rows) {
            notifyAddresses = {};
            rows.forEach(function (row) {
                notifyAddresses[row.mining_address] = row.message;
                if (is_show) console.log("Added notify address " + row.mining_address + ": " + row.message);
            });
        });
    }

    add_bans(true);
    setInterval(add_bans, 10*60*1000);

    // load merged wallet trust from files
    let numWorkers = require('os').cpus().length;
    for (let i = 1; i <= numWorkers; ++ i) {
        let fn = "wallet_trust_" + i.toString();
        let rs = fs.createReadStream(fn);
        rs.on('error', function() { console.error("Can't open " + fn + " file"); });
        let lineReader = require('readline').createInterface({ input: rs });
        lineReader.on('line', function (line) {
            let parts = line.split(/\t/);
            if (parts.length != 3) {
                console.error("Error line " + line + " ignored from " + fn + " file");
                return;
            }
            let wallet = parts[0];
            let trust  = parseInt(parts[1], 10);
            let time   = parseInt(parts[2], 10);
            if (Date.now() - time < 24*60*60*1000 && (!(wallet in walletTrust) || trust < walletTrust[wallet])) {
                debug("Adding " + trust.toString() + " trust for " + wallet + " wallet");
                walletTrust[wallet] = trust;
                walletLastSeeTime[wallet] = time;
            }
        });
    }

    // dump wallet trust and miner agents to file
    setInterval(function () {
       let str = "";
       for (let wallet in walletTrust) {
           let time = walletLastSeeTime[wallet];
           if (Date.now() - time < 24*60*60*1000) {
                str += wallet + "\t" + walletTrust[wallet].toString() + "\t" + time.toString() + "\n";
           } else {
                delete walletTrust[wallet];
                delete walletLastSeeTime[wallet];
           }
       }
       const fn = "wallet_trust_" + process.env['WORKER_ID'].toString();
       fs.writeFile(fn, str, function(err) { if (err) console.error("Error saving " + fn + " file"); });

       if (process.env['WORKER_ID'] == 1) {
           let str2 = "";
           for (let agent in minerAgents) { str2 += agent + "\n"; }
           const fn2 = "miner_agents";
           fs.writeFile(fn2, str2, function(err) { if (err) console.error("Error saving " + fn2 + " file"); });
       }

       //cacheTargetHex = {};

    }, 10*60*1000);

    // get extra wallets to check
    setInterval(function () {
       const extra_wallet_verify_fn = "extra_wallet_verify.txt";
       extra_wallet_verify = {};
       fs.access(extra_wallet_verify_fn, fs.F_OK, function(err) {
          if (err) return;
          let rs = fs.createReadStream(extra_wallet_verify_fn);
          rs.on('error', function() { console.error("Can't open " + extra_wallet_verify_fn + " file"); });
          let lineReader = require('readline').createInterface({ input: rs });
          lineReader.on('line', function (line) {
              console.log(threadName + "[EXTRA CHECK] added: '" + line + "'");
              extra_wallet_verify[line] = 1;
          });
          const fn = "extra_verify_wallet_hashes_" + process.env['WORKER_ID'].toString();
          fs.writeFile(fn, extra_verify_wallet_hashes.join("\n"), function(err) { if (err) console.error("Error saving " + fn + " file"); });
          extra_verify_wallet_hashes = [];
       });
       const wallet_debug_fn = "wallet_debug.txt";
       wallet_debug = {};
       fs.access(wallet_debug_fn, fs.F_OK, function(err) {
          if (err) return;
          let rs = fs.createReadStream(wallet_debug_fn);
          rs.on('error', function() { console.error("Can't open " + wallet_debug_fn + " file"); });
          let lineReader = require('readline').createInterface({ input: rs });
          lineReader.on('line', function (line) {
              console.log(threadName + "[WALLET DEBUG] added: '" + line + "'");
              wallet_debug[line] = 1;
          });
       });
    }, 5*60*1000);

    let lastGarbageFromIpTime = {};

    async.each(global.config.ports, function (portData) {
        if (global.config[portData.portType].enable !== true) {
            return;
        }
        let handleMessage = function (socket, jsonData, pushMessage) {
            if (!jsonData.id) {
                console.warn('Miner RPC request missing RPC id');
                return;
            } else if (!jsonData.method) {
                console.warn('Miner RPC request missing RPC method');
                return;
            }

            let sendReply = function (error, result) {
                if (!socket.writable) return;
                let reply = {
                    jsonrpc: "2.0",
                    id:      jsonData.id,
                    error:   error ? {code: -1, message: error} : null,
                    result:  result
                };
                if (jsonData.id === "Stratum") reply.method = jsonData.method;
                debug("[MINER] REPLY TO MINER: " + JSON.stringify(reply));
                if (socket.debugMiner) console.log(threadName + " [WALLET DEBUG] reply " + JSON.stringify(reply));
                socket.write(JSON.stringify(reply) + "\n");
            };
            let sendReplyFinal = function (error) {
                setTimeout(function() {
                  if (!socket.writable) return;
                  let reply = {
                    jsonrpc: "2.0",
                    id:      jsonData.id,
                    error:   {code: -1, message: error},
                    result:  null
                  };
                  if (jsonData.id === "Stratum") reply.method = jsonData.method;
                  debug("[MINER] FINAL REPLY TO MINER: " + JSON.stringify(reply));
                  if (socket.debugMiner) console.log(threadName + " [WALLET DEBUG] final reply " + JSON.stringify(reply));
                  socket.end(JSON.stringify(reply) + "\n");
                }, 9 * 1000);
            };
            debug("[MINER] GOT FROM MINER: " + JSON.stringify(jsonData));
            handleMinerData(socket, jsonData.id, jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, sendReplyFinal, pushMessage);
            if (socket.debugMiner) console.log(threadName + " [WALLET DEBUG] recieved " + JSON.stringify(jsonData));
        };

        function socketConn(socket) {
            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            let dataBuffer = '';

            let pushMessage = function (body) {
                if (!socket.writable) return;
                body.jsonrpc = "2.0";
                debug("[MINER] PUSH TO MINER: " + JSON.stringify(body));
                if (socket.debugMiner) console.log(threadName + " [WALLET DEBUG] push " + JSON.stringify(body));
                socket.write(JSON.stringify(body) + "\n");
            };

            socket.on('data', function (d) {
                dataBuffer += d;
                if (Buffer.byteLength(dataBuffer, 'utf8') > 102400) { //100KB
                    dataBuffer = null;
                    console.warn(threadName + 'Excessive packet size from: ' + socket.remoteAddress);
                    socket.destroy();
                    return;
                }
                if (dataBuffer.indexOf('\n') !== -1) {
                    let messages = dataBuffer.split('\n');
                    let incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                    for (let i = 0; i < messages.length; i++) {
                        let message = messages[i];
                        if (message.trim() === '') {
                            continue;
                        }
                        let jsonData;
                        try {
                            jsonData = JSON.parse(message);
                        }
                        catch (e) {
                            if (message.indexOf('GET /') === 0) {
                                if (message.indexOf('HTTP/1.1') !== -1) {
                                    socket.end('HTTP/1.1' + httpResponse);
                                    break;
                                }
                                else if (message.indexOf('HTTP/1.0') !== -1) {
                                    socket.end('HTTP/1.0' + httpResponse);
                                    break;
                                }
                            }

                            let time_now = Date.now();
                            if (!(socket.remoteAddress in lastGarbageFromIpTime) || time_now - lastGarbageFromIpTime[socket.remoteAddress] > 60*1000) {
                                console.warn(threadName + "Malformed message from " + socket.remoteAddress + " Message: " + JSON.stringify(message));
                                lastGarbageFromIpTime[socket.remoteAddress] = time_now;
                            }
                            socket.destroy();

                            break;
                        }
                        handleMessage(socket, jsonData, pushMessage);
                    }
                    dataBuffer = incomplete;
                }
            }).on('error', function (err) {
                //debug(threadName + "Socket Error " + err.code + " from " + socket.remoteAddress + " Error: " + err);
            }).on('close', function () {
                pushMessage = function () {};
                if (socket.miner_ids) socket.miner_ids.forEach(miner_id => activeMiners.delete(miner_id));
                if ("eth_extranonce_id" in socket) freeEthExtranonces.push(socket.eth_extranonce_id);
            });
        }

        if ('ssl' in portData && portData.ssl === true) {
            let server = tls.createServer({
                key: fs.readFileSync('cert.key'),
                cert: fs.readFileSync('cert.pem')
            }, socketConn);
            server.listen(portData.port, global.config.bind_ip, function (error) {
                if (error) {
                    console.error(threadName + "Unable to start server on: " + portData.port + " Message: " + error);
                    return;
                }
                console.log(threadName + "Started server on port: " + portData.port);
            });
            server.on('error', function (error) {
                console.error("Can't bind server to " + portData.port + " SSL port!");
            });
        } else {
            let server = net.createServer(socketConn);
            server.listen(portData.port, global.config.bind_ip, function (error) {
                if (error) {
                    console.error(threadName + "Unable to start server on: " + portData.port + " Message: " + error);
                    return;
                }
                console.log(threadName + "Started server on port: " + portData.port);
            });
            server.on('error', function (error) {
                console.error("Can't bind server to " + portData.port + " port!");
            });
        }
    });
});
