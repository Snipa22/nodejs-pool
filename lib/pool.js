"use strict";
const debug = require('debug')('pool');
const uuidV4 = require('uuid/v4');
const crypto = require('crypto');
const bignum = require('bignum');
const cluster = require('cluster');
const btcValidator = require('wallet-address-validator');
const async = require('async');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const child_process = require('child_process');

let nonceCheck = new RegExp("^[0-9a-f]{8}$");
let bannedIPs = {};
let bannedAddresses = {};
let notifyAddresses = {};
let baseDiff = global.coinFuncs.baseDiff();

let activeMiners = new Map();

let lastBlockHash        = {}; // coin key
let lastCoinHashFactor   = {}; // coin key, last set individual coin hash factor
let currCoinHashFactor   = {}; // coin key, current individual coin hash factor
let currCoinHashFactorMM = {}; // coin key, current individual coin hash factor that includes merged mining factor
let activeBlockTemplates = {}; // coin key

let pastBlockTemplates = global.support.circularBuffer(10);

let lastPortErrorTime = {}; // main coin port

const fix_daemon_sh = "./fix_daemon.sh";
let lastBlockFixTime  = {}; // time when blocks were checked to be in line with other nodes or when fix_daemon_sh was attempted
let lastBlockFixCount = {}; // number of times fix_daemon_sh was run

let httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 18\n\nMining Pool Online';
let threadName;
let minerCount = [];
let BlockTemplate = global.coinFuncs.BlockTemplate;
let hexMatch = new RegExp("^[0-9a-f]+$");
let totalShares = 0, trustedShares = 0, normalShares = 0, invalidShares = 0, outdatedShares = 0, throttledShares = 0;

// wallet -> { connectTime, count (miner), hashes, last_ver_shares }
// this is need to thottle down some high share count miners
let minerWallets = {};
const MAX_VER_SHARES_PER_SEC = 10; // per thread
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
    threadName = "(Worker " + cluster.worker.id + " - " + process.pid + ") ";
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
                console.error("Pool ID in use already for a different IP.  Update MySQL or change pool ID.");
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
                bannedIPs[message.data] = 1;
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

function retargetMiners() {
    debug(threadName + "Performing difficulty check on miners");

    function retargetMiner(miner) {
        if (miner.fixed_diff) {
            const newDiff = miner.calcNewDiff();
            if (miner.difficulty * 10 < newDiff) {
                console.log("Dropped low fixed diff " + miner.difficulty + " for " + miner.logString + " miner to " + newDiff + " dynamic diff");
                miner.fixed_diff = false;
                if (miner.setNewDiff(newDiff)) miner.sendNewJob();
            }
        } else {
            miner.updateDifficulty();
        }
    }

    global.config.ports.forEach(function (portData) { minerCount[portData.port] = 0; });
    const time_before = Date.now();
    for (var [minerId, miner] of activeMiners) { retargetMiner(miner); ++ minerCount[miner.port]; }
    const elapsed = Date.now() - time_before;
    if (elapsed > 500) console.error(threadName + "retargetMiners() consumed " + elapsed + " ms for " + activeMiners.size + " miners");
    process.send({type: 'minerPortCount', data: { worker_id: cluster.worker.id, ports: minerCount } });
}

// wallet " " proxy miner name -> { connectTime, count (miner), hashes }
// this is needed to set cummulative based diff for workers provided by Atreides proxy and xmrig-proxy
let proxyMiners = {};

function addProxyMiner(miner) {
    if (miner.proxyMinerName) return;

    const proxyMinerName = miner.payout + ":" + miner.identifier;
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
}

function checkAliveMiners() {
    debug(threadName + "Verifying if miners are still alive");
    const time_before = Date.now();
    const deadline = time_before - global.config.pool.minerTimeout * 1000;
    for (var [minerId, miner] of activeMiners) if (miner.lastContact < deadline) removeMiner(miner);
    const elapsed = Date.now() - time_before;
    if (elapsed > 500) console.error(threadName + "checkAliveMiners() consumed " + elapsed + " ms for " + activeMiners.size + " miners");
}

function set_hash_factor(coin, hash_factor) {
    currCoinHashFactor[coin] = hash_factor;
}

// global.config.daemon["activePort" + coin] is only updated in master thread
function updateActivePort(coin) {
    global.support.getActivePort(coin, function (newActivePort) {
        const oldActivePort = global.config.daemon["activePort" + coin];
        if (newActivePort === null) {
            if (coin === "" && oldActivePort != global.config.daemon.port) {
                console.error("Error getting activePort, so rolling back to main port");
                global.config.daemon.activePort = global.config.daemon.port;
            } else {
                console.error("Error getting activePort" + coin);
                coinHashFactorUpdate(coin, 0);
            }
        } else {
            if (coin !== "") {
                global.support.getCoinHashFactor(coin, function (newCoinHashFactor) {
                    if (newCoinHashFactor === null) {
                        console.error("Error getting coinHashFactor" + coin);
                        coinHashFactorUpdate(coin, 0);
                    } else {
                        if (!newActivePort || !newCoinHashFactor) coinHashFactorUpdate(coin, 0);
                        else set_hash_factor(coin, newCoinHashFactor);
                        if (oldActivePort !== newActivePort) {
                            console.log("Changing activePort" + coin + " from " + oldActivePort + " to " + newActivePort);
                            global.config.daemon["activePort" + coin] = newActivePort;
                        }
                    }
                });
            } else if (oldActivePort !== newActivePort) {
                if (!(newActivePort in lastPortErrorTime) || Date.now() - lastPortErrorTime[newActivePort] > 30*60*1000) {
                    console.log("Changing activePort" + coin + " from " + oldActivePort + " to " + newActivePort);
                    global.config.daemon["activePort" + coin] = newActivePort;
                } else if ((Date.now() - lastPortErrorTime[newActivePort]) % 60*1000 < 6*1000) { // print every 10th message
                    console.warn("Avoiding changing recently problem activePort" + coin + " from " + oldActivePort + " to " + newActivePort);
                }
            }
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
            template.child_template         = activeBlockTemplates[child_coin];
            template.child_template_buffer  = template.child_template.buffer;
console.log("DEBUG: BT1");
console.log(template.child_template_buffer);
console.log(template.child_template_buffer.toString('hex'));
console.log(JSON.stringify(template.child_template_buffer));
            template.parent_extra_nonce_hex = global.coinFuncs.constructMMParentBlockExtraNonce(
                new Buffer(rpc_template.blocktemplate_blob, 'hex'), port, template.child_template_buffer
            ).toString('hex');
console.log("DEBUG: BT2");
console.log(template.child_template_buffer);
console.log(template.child_template_buffer.toString('hex'));
console.log(JSON.stringify(template.child_template_buffer));
        }
    }

    return template;
}

// templateUpdateReal is only called in master thread (except the beginning of a worker thread)
function templateUpdateReal(coin, activePort, coinHashFactor, isHashFactorChange) {
    global.coinFuncs.getPortBlockTemplate(activePort, function (rpcResponse) {
        if (activePort !== global.config.daemon["activePort" + coin]) {
            console.log("Aborting " + activePort + " last block template request because " + "activePort" + coin + " was already changed to " + global.config.daemon["activePort" + coin] + " port");
            return;
        }
        if (rpcResponse && typeof rpcResponse.result !== 'undefined') {
            const rpc_template = rpcResponse.result;
            const template = process_rpc_template(rpc_template, coin, activePort, coinHashFactor, isHashFactorChange);
            debug(threadName + "New block template found at " + rpc_template.height + " height");
            if (cluster.isMaster) {
                sendToWorkers({type: 'newBlockTemplate', data: template});
                setNewBlockTemplate(template);
                // update parent coins if current coin was updated now
                if (activePort in global.coinFuncs.getMM_CHILD_PORTS()) {
                    const parent_ports = global.coinFuncs.getMM_CHILD_PORTS()[activePort];
                    for (let parent_port in parent_ports) {
                        const parent_coin = global.coinFuncs.PORT2COIN(parent_port);
                        if (parent_coin in activeBlockTemplates) {
                            const parent_template = process_rpc_template(activeBlockTemplates[parent_coin], parent_coin, parent_port, currCoinHashFactor[parent_coin], false);
                            sendToWorkers({type: 'newBlockTemplate', data: parent_template});
                            setNewBlockTemplate(parent_template);
                        }
                    }
                }
            } else {
                setNewBlockTemplate(template);
            }
        } else {
            console.error("Block template request failed for " + activePort + " port.");
            coinHashFactorUpdate(coin, 0);
            setTimeout(templateUpdateReal, 3000, coin, activePort, coinHashFactor, isHashFactorChange);
        }
    });
}

function coinHashFactorUpdate(coin, coinHashFactor) {
    if (coin === "") return;
    if (currCoinHashFactor[coin] === 0 && coinHashFactor === 0) return;
    if (cluster.isMaster) {
        //console.log('[*] New ' + coin + ' coin hash factor is set from ' + currCoinHashFactor[coin] + ' to ' + coinHashFactor);
        let data = { coin: coin, coinHashFactor: coinHashFactor };
        sendToWorkers({type: 'newCoinHashFactor', data: data});
    }
    setNewCoinHashFactor(true, coin, coinHashFactor);
}

// templateUpdate is only called in master thread (except the beginning of a worker thread)
function templateUpdate(coin, repeating) {
    const activePort     = global.config.daemon["activePort" + coin];
    const coinHashFactor = currCoinHashFactor[coin];
    if (activePort && coinHashFactor) global.coinFuncs.getPortLastBlockHeader(activePort, function (err, body) {
        if (activePort !== global.config.daemon["activePort" + coin]) {
            console.log("Aborting " + activePort + " last block header request because activePort" + coin + " was already changed to " + global.config.daemon["activePort" + coin] + " port");
            if (repeating === true) setTimeout(templateUpdate, 50, coin, repeating);
        } else if (err === null) {
            const isHashFactorChange = !(coin in lastCoinHashFactor) || Math.abs(lastCoinHashFactor[coin] - coinHashFactor) / coinHashFactor > 0.05;
            if (!(coin in lastBlockHash) || body.hash !== lastBlockHash[coin]) {
                lastBlockHash[coin] = body.hash;
                templateUpdateReal(coin, activePort, coinHashFactor, isHashFactorChange);
            } else if (isHashFactorChange && lastCoinHashFactor[coin]) {
                coinHashFactorUpdate(coin, coinHashFactor);
            }
            if (repeating === true) setTimeout(templateUpdate, 50, coin, repeating);
        } else {
            console.error("Last block header request for " + global.config.daemon["activePort" + coin] + " port failed!");
            coinHashFactorUpdate(coin, 0);
            setTimeout(templateUpdate, 1000, coin, repeating);
        }
    }); else if (cluster.isMaster) {
      coinHashFactorUpdate(coin, 0);
      setTimeout(templateUpdate, 1000, coin, repeating);
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

function setNewCoinHashFactor(isHashFactorChange, coin, coinHashFactor, check_height) {
    if (isHashFactorChange) lastCoinHashFactor[coin] = coinHashFactor;

    // used in miner.selectBestCoin
    currCoinHashFactorMM[coin] = coinHashFactor;
    const port = global.coinFuncs.COIN2PORT(coin);
    const is_mm = port in global.coinFuncs.getMM_PORTS();
    if (is_mm) {
        const child_coin = global.coinFuncs.PORT2COIN(global.coinFuncs.getMM_PORTS()[port]);
        if (child_coin in lastCoinHashFactor) currCoinHashFactorMM[coin] += lastCoinHashFactor[child_coin];
    }

    if (cluster.isMaster) {
        console.log('[*] New ' + coin + ' coin hash factor is set from ' + currCoinHashFactor[coin] + ' to ' + coinHashFactor + (is_mm ? ' (MM: ' + currCoinHashFactorMM[coin] + ')' : ""));
    }
    if (coin !== "") set_hash_factor(coin, coinHashFactor);
    if (!(coin in activeBlockTemplates)) return;

    // update parent coins if current coin was updated now
    if (isHashFactorChange) if (port in global.coinFuncs.getMM_CHILD_PORTS()) {
        const parent_ports = global.coinFuncs.getMM_CHILD_PORTS()[port];
        for (let parent_port in parent_ports) {
            const parent_coin = global.coinFuncs.PORT2COIN(parent_port);
            if (parent_coin in lastCoinHashFactor) {
                setNewCoinHashFactor(true, parent_coin, lastCoinHashFactor[parent_coin], 0);
            }
        }
    }

    const time_before = Date.now();

    if (isHashFactorChange) {
        const port          = activeBlockTemplates[coin].port;
        const block_version = activeBlockTemplates[coin].buffer[0];
        const algo          = global.coinFuncs.algoShortTypeStr(port, block_version);

        if (cluster.isMaster) console.log(threadName + "Full BT update for coin " + coin + " with hash factor changed to " + currCoinHashFactorMM[coin]);

        if (check_height) {
            for (var [minerId, miner] of activeMiners) {
                if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) continue;
                miner.trust.check_height = check_height;
                miner.sendNewJob();
            }
        } else {
            for (var [minerId, miner] of activeMiners) {
                if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) continue;
                miner.sendNewJob();
            }
        }
    } else {
        if (cluster.isMaster) console.log(threadName + "Fast BT update for coin " + coin + " with the same " + currCoinHashFactorMM[coin] + " hash factor");
        if (check_height) {
            for (var [minerId, miner] of activeMiners) {
                //if (typeof(miner.curr_coin) === 'undefined') console.error("[INTERNAL ERROR]: " + miner.logString + ": undefined curr_coin");
                if (miner.curr_coin !== coin) continue;
                //if (!(coin in miner.coin_perf)) console.error("[INTERNAL ERROR]: " + miner.logString + ": no longer supported coin " + coin + " in miner " + JSON.stringify(miner.coin_perf) + " coin_perf");
                //if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) console.error("[INTERNAL ERROR]: " + miner.logString + ": no longer supported algo " + algo + " in miner " + JSON.stringify(miner.algos) + " algos");
                miner.trust.check_height = check_height;
                miner.sendNewCoinJob(coin);
            }
        } else {
            for (var [minerId, miner] of activeMiners) {
                //if (typeof(miner.curr_coin) === 'undefined') console.error("[INTERNAL ERROR]: " + miner.logString + ": undefined curr_coin");
                if (miner.curr_coin !== coin) continue;
                //if (!(coin in miner.coin_perf)) console.error("[INTERNAL ERROR]: " + miner.logString + ": no longer supported coin " + coin + " in miner " + JSON.stringify(miner.coin_perf) + " coin_perf");
                //if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) console.error("[INTERNAL ERROR]: " + miner.logString + ": no longer supported algo " + algo + " in miner " + JSON.stringify(miner.algos) + " algos");
                miner.sendNewCoinJob(coin);
            }
        }
    }

    const elapsed = Date.now() - time_before;
    if (elapsed > 500) console.error(threadName + "setNewCoinHashFactor() consumed " + elapsed + " ms for " + activeMiners.size + " miners");
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
        activeBlockTemplates[coin].timeOutdate = Date.now() + 4*1000;
        pastBlockTemplates.enq(activeBlockTemplates[coin]);
        if (activeBlockTemplates[coin].port != template.port && global.config.pool.trustedMiners) isExtraCheck = true;
    }
    if (cluster.isMaster) {
        const coin_str = coin === "" ? "" : coin + " ";
        console.log('[*] New ' + coin_str + 'block to mine at ' + template.height + ' height with ' + template.difficulty + ' difficulty and ' + template.port + ' port (with coin hash factor ' + template.coinHashFactor + ")");
    } else {
        debug(threadName + 'New block to mine at ' + template.height + ' height with ' + template.difficulty + ' difficulty and ' + template.port + ' port');
    }

    activeBlockTemplates[coin] = new BlockTemplate(template);

if ("child_template" in activeBlockTemplates[coin] && cluster.isMaster) {
console.log("DEBUG: BT2");
console.log(activeBlockTemplates[coin].child_template_buffer);
console.log(activeBlockTemplates[coin].child_template_buffer.toString('hex'));
console.log(JSON.stringify(activeBlockTemplates[coin].child_template_buffer));
}

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

// miner agent strings (for cluster.worker.id == 1)
let minerAgents = {};

var reEmail = /^\S+@\S+\.\S+$/;
// wallet password last check time
let walletLastCheckTime = {};

function Miner(id, login, pass, ipAddress, startingDiff, messageSender, protoVersion, portType, port, agent, algos, algos_perf, algo_min_time) {
    // Username Layout - <address in BTC or XMR>.<Difficulty>
    // Password Layout - <password>.<miner identifier>.<payment ID for XMR>
    // Default function is to use the password so they can login.  Identifiers can be unique, payment ID is last.
    // If there is no miner identifier, then the miner identifier is set to the password
    // If the password is x, aka, old-logins, we're not going to allow detailed review of miners.

    let diffSplit = login.split("+");
    let addressSplit = diffSplit[0].split('.');
    let pass_split = pass.split(":");

    // Workaround for a common mistake to put email without : before it
    // and also security measure to hide emails used as worker names
    if (pass_split.length === 1 && reEmail.test(pass_split[0])) {
        pass_split.push(pass_split[0]);
        pass_split[0] = "email";
    }

    // 1) set payout, identifier, email and logString

    this.payout = this.address = addressSplit[0];
    this.paymentID = null;

    this.identifier = agent && agent.includes('MinerGate') ? "MinerGate" : pass_split[0].substring(0, 64);
    if (typeof(addressSplit[1]) !== 'undefined') {
        if (addressSplit[1].length === 64 && hexMatch.test(addressSplit[1]) && global.coinFuncs.validatePlainAddress(this.address)) {
            this.paymentID = addressSplit[1];
            this.payout += "." + this.paymentID;
            if (typeof(addressSplit[2]) !== 'undefined' && this.identifier === 'x') {
                this.identifier = addressSplit[2].substring(0, 64);
            }
        } else if (this.identifier === 'x') {
            this.identifier = addressSplit[1].substring(0, 64);
        }
    }

    this.debugMiner = this.payout == global.coinFuncs.testDevAddress;

    this.email = pass_split.length === 2 ? pass_split[1] : "";
    this.logString = this.payout.substr(this.payout.length - 10) + ":" + this.identifier + " (" + ipAddress + ")";

    // 2) check stuff

    if (diffSplit.length > 2) {
        this.error = "Too many options in the login field";
        this.valid_miner = false;
        return;
    }

    if (pass_split.length > 2) {
        this.error = "Too many options in the password field";
        this.valid_miner = false;
        return;
    }

    if (this.payout in bannedAddresses) { // Banned Address
        this.error = "Banned payment address provided: " + bannedAddresses[this.payout];
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
    } else if (btcValidator.validate(this.address)) {
        if (global.config.general.allowBitcoin && global.coinFuncs.supportsAutoExchange) {
            this.bitcoin = 1;
        } else {
            this.error = "This pool does not allow payouts to bitcoin";
            this.valid_miner = false;
            return;
        }
    } else {
        this.error = "Invalid payment address provided: " + this.address;
        this.valid_miner = false;
        return;
    }

    if (!("" in activeBlockTemplates)) {
        this.error = "No active block template";
        this.valid_miner = false;
        return;
    }

    this.setAlgos = function(algos, algos_perf, algo_min_time) {
        const check = global.coinFuncs.algoCheck(algos);
        if (check === true) {
            this.algos = {};
            for (let i in algos) this.algos[algos[i]] = 1;
        } else {
            return check;
        }
        const coin_perf = global.coinFuncs.convertAlgosToCoinPerf(algos_perf);
        if (coin_perf instanceof Object) {
            this.coin_perf = coin_perf;
        } else {
            return coin_perf;
        }
        this.algo_min_time = algo_min_time ? algo_min_time : 0;
        return "";
    };

    if (algos && algos instanceof Array && global.config.daemon.enableAlgoSwitching) {
        if (!algos_perf || !(algos_perf instanceof Object)) algos_perf = global.coinFuncs.getDefaultAlgosPerf();
    } else {
        algos         = global.coinFuncs.getDefaultAlgos();
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

    this.proxy = agent && agent.includes('xmr-node-proxy');
    this.id = id;
    this.ipAddress = ipAddress;
    this.messageSender = messageSender;
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

    // 3c) diff stuff

    this.lastShareTime = Math.floor(Date.now() / 1000);
    this.validShares = 0;
    this.invalidShares = 0;
    this.hashes = 0;

    this.fixed_diff = false;
    this.difficulty = startingDiff;

    if (agent && agent.includes('NiceHash')) {
        this.fixed_diff = true;
        this.difficulty = global.coinFuncs.niceHashDiff;
    }
    if (diffSplit.length === 2) {
        this.fixed_diff = true;
        this.difficulty = Number(diffSplit[1]);
        if (this.difficulty < global.config.pool.minDifficulty) {
            this.difficulty = global.config.pool.minDifficulty;
        }
        if (this.difficulty > global.config.pool.maxDifficulty) {
            this.difficulty = global.config.pool.maxDifficulty;
        }
    }

    // 3d) trust stuff

    if (global.config.pool.trustedMiners) {
        if (!(this.payout in walletTrust)) {
            walletTrust[this.payout] = 0;
            walletLastSeeTime[this.payout] = Date.now();
        }
        let is_trusted_wallet = this.difficulty <= 16001 && this.payout in walletTrust && walletTrust[this.payout] > global.config.pool.trustThreshold * 20;
        this.trust = {
            threshold:   is_trusted_wallet ? 1 : global.config.pool.trustThreshold,
            probability: is_trusted_wallet ? global.config.pool.trustMin : 256,
            penalty: 0,
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

    this.invalidShareProto = global.protos.InvalidShare.encode({
        paymentAddress: this.address,
        paymentID: this.paymentID,
        identifier: this.identifier
    });

    this.selectBestCoin = function() {
        if (this.debugMiner) console.log(threadName + this.logString + ": current coin is " + this.curr_coin);
        if (typeof(this.curr_coin) !== 'undefined' && this.curr_coin_time && currCoinHashFactorMM[this.curr_coin] &&
            Date.now() - this.curr_coin_time < this.algo_min_time*1000
        ) {
           return this.curr_coin;
        }
        let best_coin = "";
        let best_coin_perf = this.coin_perf[""] * 1.1;
        let miner = this;
        COINS.forEach(function(coin) {
            if (!(coin in miner.coin_perf)) {
              if (miner.debugMiner) console.log(threadName + miner.logString + ": " + coin + ": no coin_perf");
              return;
            }
            if (!(coin in activeBlockTemplates)) {
              if (miner.debugMiner) console.log(threadName + miner.logString + ": " + coin + ": no activeBlockTemplates");
              return;
            }
            const coinHashFactor = currCoinHashFactorMM[coin];
            if (!coinHashFactor) {
              if (miner.debugMiner) console.log(threadName + miner.logString + ": " + coin + ": no coinHashFactor");
              return;
            }
            const bt            = activeBlockTemplates[coin];
            const port          = bt.port;
            const block_version = bt.buffer[0];
            const algo          = global.coinFuncs.algoShortTypeStr(port, block_version);
            if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) {
              if (miner.debugMiner) console.log(threadName + miner.logString + ": " + coin + ": no algo support");
              return;
            }
            let coin_perf = miner.coin_perf[coin] * coinHashFactor;
            if (miner.curr_coin === coin) coin_perf *= 1.05;
            if (miner.debugMiner) console.log(threadName + miner.logString + ": " + coin + ": " + coin_perf);
            if (coin_perf > best_coin_perf) {
                best_coin      = coin;
                best_coin_perf = coin_perf;
            }
        });
        if (typeof(this.curr_coin) === 'undefined' || this.curr_coin != best_coin) {
            if (typeof(this.curr_coin) !== 'undefined') {
                let factor = this.coin_perf[best_coin] / this.coin_perf[this.curr_coin];
                if (factor > 10) factor = 10;
                else if (factor < 0.1) factor = 0.1;
                //const proxyMinerName = this.payout + ":" + this.identifier;
                //if (proxyMinerName in proxyMiners) proxyMiners[proxyMinerName].hashes *= factor;
                //if (this.payout in minerWallets) minerWallets[this.payout].hashes *= factor;
                this.hashes *= factor;
                if (this.hashesShift) this.hashesShift *= factor;
                this.setNewDiff(this.calcNewDiff());
            }
            this.curr_coin      = best_coin;
            this.curr_coin_time = Date.now();
            if (global.config.pool.trustedMiners) this.trust.check_height = activeBlockTemplates[best_coin].height;
        }
        return best_coin;
    }

    this.calcNewDiff = function () {
        const proxyMinerName = this.payout + ":" + this.identifier;
        let miner;
        let target;
        let min_diff;
        let history_time;
        if (proxyMinerName in proxyMiners) {
            miner = proxyMiners[proxyMinerName];
            target = 5;
            min_diff = 10*global.config.pool.minDifficulty;
            history_time = 5;
        } else if (this.payout in minerWallets && minerWallets[this.payout].last_ver_shares >= MAX_VER_SHARES_PER_SEC * VER_SHARES_PERIOD) {
            miner = minerWallets[this.payout];
            target = 5;
            min_diff = 10*global.config.pool.minDifficulty;
            history_time = 5;
        } else {
            miner = this;
            target = this.proxy ? 5 : global.config.pool.targetTime;
            min_diff = this.proxy ? 10*global.config.pool.minDifficulty : global.config.pool.minDifficulty;
            history_time = 60;
        }
        if (miner.connectTimeShift) {
            if (Date.now() - miner.connectTimeShift > history_time*60*1000) {
                miner.connectTime = miner.connectTimeShift;
                miner.hashes -= miner.hashesShift;
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
        const diff = Math.floor(hashes * target / period);
        return diff < min_diff ? min_diff : diff;
    };

    this.updateDifficulty = function () {
        if (this.fixed_diff) return;
        if (this.setNewDiff(this.calcNewDiff())) this.sendNewJob();
    };

    this.setNewDiff = function (difficulty) {
        if (this.fixed_diff) return false;

        let newDiff = Math.round(difficulty);
        if (newDiff > global.config.pool.maxDifficulty && !this.proxy) {
            newDiff = global.config.pool.maxDifficulty;
        }
        if (newDiff < global.config.pool.minDifficulty) {
            newDiff = global.config.pool.minDifficulty;
        }

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

    this.checkBan = function (validShare) {
        if (!global.config.pool.banEnabled) {
            return;
        }

        // Valid stats are stored by the pool.
        if (validShare) {
            ++ this.validShares;
        } else {
            ++ this.invalidShares;
        }
        if (this.validShares + this.invalidShares >= global.config.pool.banThreshold) {
            if (this.invalidShares / this.validShares >= global.config.pool.banPercent / 100) {
                removeMiner(this);
                process.send({type: 'banIP', data: this.ipAddress});
            } else {
                this.invalidShares = 0;
                this.validShares = 0;
            }
        }
    };

    if (protoVersion === 1) {
        this.getTargetHex = function () {
            let padded = new Buffer(32);
            padded.fill(0);
            let diffBuff = baseDiff.div(this.difficulty).toBuffer();
            diffBuff.copy(padded, 32 - diffBuff.length);

            let buff = padded.slice(0, 4);
            let buffArray = buff.toByteArray().reverse();
            let buffReversed = new Buffer(buffArray);
            this.target = buffReversed.readUInt32BE(0);
            return buffReversed.toString('hex');
        };

        this.getCoinJob = function (coin) {
            let bt = activeBlockTemplates[coin];
            if (this.jobLastBlockHash === bt.idHash && !this.newDiffToSet && this.cachedJob !== null) return null;
            this.jobLastBlockHash = bt.idHash;
            if (this.newDiffToSet) {
                this.difficulty = this.newDiffToSet;
                this.newDiffToSet = null;
                this.newDiffRecommendation = null;
            } else if (this.newDiffRecommendation) {
                this.difficulty = this.newDiffRecommendation;
                this.newDiffRecommendation = null;
            }

            const coinHashFactor = currCoinHashFactorMM[coin];
            const algo_name      = global.coinFuncs.algoShortTypeStr(bt.port, bt.buffer[0]);
            const variant_name   = algo_name.split('/')[1];

            if (!this.proxy) {
                let blob = bt.nextBlob();
                let target = this.getTargetHex();
                let newJob = {
                    id:             crypto.pseudoRandomBytes(21).toString('base64'),
                    coin:           coin,
                    blockHash:      bt.idHash,
                    extraNonce:     bt.extraNonce,
                    height:         bt.height,
                    difficulty:     this.difficulty,
                    diffHex:        this.diffHex,
                    coinHashFactor: coinHashFactor,
                    submissions:    {}
                };
                this.validJobs.enq(newJob);
                this.cachedJob = {
                    blob:    blob,
                    algo:    algo_name,
                    variant: variant_name,
                    height:  bt.height,
                    job_id:  newJob.id,
                    target:  target,
                    id:      this.id
                };
            } else {
                let blob = bt.nextBlobWithChildNonce();
                let newJob = {
                    id:                  crypto.pseudoRandomBytes(21).toString('base64'),
                    coin:                coin,
                    blockHash:           bt.idHash,
                    extraNonce:          bt.extraNonce,
                    height:              bt.height,
                    difficulty:          this.difficulty,
                    diffHex:             this.diffHex,
                    clientPoolLocation:  bt.clientPoolLocation,
                    clientNonceLocation: bt.clientNonceLocation,
                    coinHashFactor:      coinHashFactor,
                    submissions:         {}
                };
                this.validJobs.enq(newJob);
                const algo_name = global.coinFuncs.algoShortTypeStr(bt.port, bt.buffer[0]);
                this.cachedJob = {
                    blocktemplate_blob:  blob,
                    blob_type:           global.coinFuncs.blobTypeStr(bt.port, bt.buffer[0]),
                    algo:                algo_name,
                    variant:             variant_name,
                    difficulty:          bt.difficulty,
                    height:              bt.height,
                    reserved_offset:     bt.reserveOffset,
                    client_nonce_offset: bt.clientNonceLocation,
                    client_pool_offset:  bt.clientPoolLocation,
                    target_diff:         this.difficulty,
                    target_diff_hex:     this.diffHex,
                    job_id:              newJob.id,
                    id:                  this.id
                };
            }
            return this.cachedJob;
        };
        this.getJob = function () {
            return this.getCoinJob(this.selectBestCoin());
        };

        this.sendNewCoinJob = function(coin) {
            const job = this.getCoinJob(coin);
            if (job === null) return;
            return this.messageSender('job', job);
        };
        this.sendNewJob = function() {
            return this.sendNewCoinJob(this.selectBestCoin());
        };
    }
}

// store wallet_key (address, paymentID, bitcoin, poolTypeEnum, port) -> worker_name -> shareType -> (height, difficulty, time, acc, acc2)
let walletAcc             = {};
// number of worker_name for wallet_key (so we do not count them by iteration)
let walletWorkerCount     = {};
// is share finalizer function for dead worker_name is active
let is_walletAccFinalizer = {};

function walletAccFinalizer(wallet_key, miner_address, miner_paymentID, miner_bitcoin, miner_poolTypeEnum, miner_port) {
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
                global.database.storeShare(height, global.protos.Share.encode({
                    shares: acc,
                    shares2: worker.acc2,
                    paymentAddress: miner_address,
                    paymentID: miner_paymentID,
                    foundBlock: false,
                    trustedShare: true,
                    poolType: miner_poolTypeEnum,
                    poolID: global.config.pool_id,
                    blockDiff: worker.difficulty,
                    bitcoin: miner_bitcoin,
                    blockHeight: height,
                    timestamp: time_now,
                    identifier: worker_name,
                    port: miner_port,
                    share_num: worker.share_num
                }));
            }
            debug("!!! " + wallet_key + ": removing old worker " + worker_name);
            if (worker_name !== "all_other_workers") -- walletWorkerCount[wallet_key];
            delete wallet[worker_name];
        } else {
            is_something_left = true;
        }
    }

    if (is_something_left) {
        setTimeout(walletAccFinalizer, 60*1000, wallet_key, miner_address, miner_paymentID, miner_bitcoin, miner_poolTypeEnum, miner_port);
    } else {
        is_walletAccFinalizer[wallet_key] = false;
    }
}

function recordShareData(miner, job, shareDiff, blockCandidate, hashHex, shareType, blockTemplate) {
    miner.hashes += job.difficulty;
    let proxyMinerName = miner.payout + ":" + miner.identifier;
    if (proxyMinerName in proxyMiners) proxyMiners[proxyMinerName].hashes += job.difficulty;

    let time_now = Date.now();
    let wallet_key = miner.address + " " + miner.paymentID + " " + miner.bitcoin + " " + miner.poolTypeEnum + " " + blockTemplate.port;

    if (!(wallet_key in walletAcc)) {
        walletAcc[wallet_key] = {};
        walletWorkerCount[wallet_key] = 0;
        is_walletAccFinalizer[wallet_key] = false;
    }

    let db_job_height = global.config.daemon.port == blockTemplate.port ? job.height : anchorBlockHeight;

    if (job.difficulty >= 1000000 || blockCandidate) {

        global.database.storeShare(db_job_height, global.protos.Share.encode({
            shares: job.rewarded_difficulty,
            shares2: job.rewarded_difficulty2, 
            paymentAddress: miner.address,
            paymentID: miner.paymentID,
            foundBlock: blockCandidate,
            trustedShare: shareType,
            poolType: miner.poolTypeEnum,
            poolID: global.config.pool_id,
            blockDiff: blockTemplate.difficulty,
            bitcoin: miner.bitcoin,
            blockHeight: db_job_height,
            timestamp: time_now,
            identifier: miner.identifier,
            port: blockTemplate.port,
            share_num: 1
        }));

    } else {
    
        let wallet = walletAcc[wallet_key];
    
        let worker_name = miner.identifier in wallet || walletWorkerCount[wallet_key] < 50 ? miner.identifier : "all_other_workers";
    
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
    
        if (height !== db_job_height || difficulty !== blockTemplate.difficulty || time_now - worker.time > 60*1000 || acc >= 1000000) {
            if (acc != 0) {
                debug("!!! " + wallet_key + " / " + worker_name  + ": storing share " + height + " " + difficulty + " " + time_now + " " + acc);
                global.database.storeShare(height, global.protos.Share.encode({
                    shares: acc,
                    shares2: acc2,
                    paymentAddress: miner.address,
                    paymentID: miner.paymentID,
                    foundBlock: false,
                    trustedShare: shareType,
                    poolType: miner.poolTypeEnum,
                    poolID: global.config.pool_id,
                    blockDiff: difficulty,
                    bitcoin: miner.bitcoin,
                    blockHeight: height,
                    timestamp: time_now,
                    identifier: worker_name,
                    port: blockTemplate.port,
                    share_num: share_num
                }));
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
    }

    if (is_walletAccFinalizer[wallet_key] === false) {
        is_walletAccFinalizer[wallet_key] = true;
        setTimeout(walletAccFinalizer, 60*1000, wallet_key, miner.address, miner.paymentID, miner.bitcoin, miner.poolTypeEnum, blockTemplate.port);
    }

    if (blockCandidate) {
        if (global.config.daemon.port == blockTemplate.port) {
            global.database.storeBlock(job.height, global.protos.Block.encode({
                hash: hashHex,
                difficulty: blockTemplate.difficulty,
                shares: 0,
                timestamp: time_now,
                poolType: miner.poolTypeEnum,
                unlocked: false,
                valid: true
            }));
        } else {
            global.database.storeAltBlock(Math.floor(time_now / 1000), global.protos.AltBlock.encode({
                hash: hashHex,
                difficulty: blockTemplate.difficulty,
                shares: 0,
                timestamp: time_now,
                poolType: miner.poolTypeEnum,
                unlocked: false,
                valid: true,
                port: blockTemplate.port,
                height: job.height,
                anchor_height: anchorBlockHeight
            }));
        }
    }
    if (shareType) {
        process.send({type: 'trustedShare'});
        debug(threadName + "Accepted trusted share at difficulty: " + job.difficulty + "/" + job.rewarded_difficulty + "/" + shareDiff + " from: " + miner.logString);
    } else {
        process.send({type: 'normalShare'});
        debug(threadName + "Accepted valid share at difficulty: " + job.difficulty + "/" + job.rewarded_difficulty + "/" + shareDiff + " from: " + miner.logString);
    }
    if (activeBlockTemplates[blockTemplate.coin].idHash !== job.blockHash) {
        process.send({type: 'outdatedShare'});
    }

}

function getShareBuffer(miner, job, blockTemplate, params) {
    let nonce = params.nonce;
    let resultHash = params.result;
    let template = new Buffer(blockTemplate.buffer.length);
    if (!miner.proxy) {
        blockTemplate.buffer.copy(template);
        template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);
    } else {
        blockTemplate.buffer.copy(template);
        template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);
        template.writeUInt32BE(params.poolNonce, job.clientPoolLocation);
        template.writeUInt32BE(params.workerNonce, job.clientNonceLocation);
    }
    try {
        let shareBuffer = global.coinFuncs.constructNewBlob(template, new Buffer(nonce, 'hex'), blockTemplate.port);
        return shareBuffer;
    } catch (e) {
        const err_str = "Can't constructNewBlob with " + nonce + " nonce from " + miner.logString + ": " + e;
        console.error(err_str);
        global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't constructNewBlob", err_str);
        return null;
    }
}


function invalid_share(miner) {
    process.send({type: 'invalidShare'});
    miner.sendNewJob();
    walletTrust[miner.payout] = 0;
    return false;
}

function submit_block(miner, job, blockTemplate, shareBuffer, retry) {
    global.support.rpcPortDaemon(blockTemplate.port, 'submitblock', [shareBuffer.toString('hex')], function (rpcResult) {
        if (rpcResult.error) {
            // Did not manage to submit a block.  Log and continue on.
            recordShareData(miner, job, hashDiff.toString(), false, null, shareType, blockTemplate);
            let isNotifyAdmin = true;
            if (shareType) {
                let convertedBlob = global.coinFuncs.convertBlob(shareBuffer, blockTemplate.port);
                hash = global.coinFuncs.cryptoNight(convertedBlob, blockTemplate.port, blockTemplate.height);
                if (hash.toString('hex') !== resultHash) isNotifyAdmin = false;
            }

            console.error(threadName + "Error submitting block at height " + blockTemplate.height + " (active block template height: " + activeBlockTemplates[blockTemplate.coin].height + ") from " + miner.logString + ", share type: " + shareType + ", valid: " + isNotifyAdmin + " error: " + JSON.stringify(rpcResult.error));

            if (isNotifyAdmin) setTimeout(function() { // only alert if block height is not changed in the nearest time
                global.coinFuncs.getPortLastBlockHeader(blockTemplate.port, function(err, body) {
                    if (err !== null) {
                        console.error("Last block header request failed for " + blockTemplate.port + " port!");
                        return;
                    }
                    if (blockTemplate.height == body.height + 1) global.support.sendEmail(global.config.general.adminEmail,
                        "FYI: Can't submit block to deamon on " + blockTemplate.port + " port",
                        "The pool server: " + global.config.hostname + " can't submit block to deamon on " + blockTemplate.port + " port\n" +
                        "Input: " + shareBuffer.toString('hex') + "\n" +
                        threadName + "Error submitting block at " + blockTemplate.height + " height from " + miner.logString + ", share type: " + shareType + " error: " + JSON.stringify(rpcResult.error)
                    );
               });
            }, 2*1000);

            if (global.config.pool.trustedMiners) {
                debug(threadName + "Share trust broken by " + miner.logString);
                miner.trust.probability   = 256;
                miner.trust.penalty       = global.config.pool.trustPenalty;
                miner.trust.threshold     = global.config.pool.trustThreshold;
                walletTrust[miner.payout] = 0;
            }
        } else if (rpcResult && typeof(rpcResult.result) !== 'undefined') {
            // Success! Submitted a block without an issue.
            const blockFastHash = global.coinFuncs.getBlockID(shareBuffer, blockTemplate.port).toString('hex');
            console.log(threadName + "Block " + blockFastHash.substr(0, 6) + " found at height " + blockTemplate.height + " by " + miner.logString +
                ", share type: " + shareType + " - submit result: " + JSON.stringify(rpcResult.result)
            );
            recordShareData(miner, job, hashDiff.toString(), true, blockFastHash, shareType, blockTemplate);
        } else {
            if (retry) {
                setTimeout(submit_block, 500, false);
            } else {
                // RPC bombed out massively.
                console.error(threadName + "RPC Error. Please check logs for details");
                global.support.sendEmail(global.config.general.adminEmail,
                    "FYI: Can't submit block to deamon on " + blockTemplate.port + " port",
                    "Input: " + shareBuffer.toString('hex') + "\n" +
                    "The pool server: " + global.config.hostname + " can't submit block to deamon on " + blockTemplate.port + " port\n" +
                    "RPC Error. Please check logs for details"
                );
            }
        }
    });
}

function processShare(miner, job, blockTemplate, params) {
    let hash;
    let shareType;
    let shareBuffer;
    const resultHash = params.result;

    if (miner.payout in minerWallets) minerWallets[miner.payout].hashes += job.difficulty;
    walletLastSeeTime[miner.payout] = Date.now();

    if (global.config.pool.trustedMiners && miner.difficulty < 400000 && miner.trust.threshold <= 0 && miner.trust.penalty <= 0 &&
        crypto.randomBytes(1).readUIntBE(0, 1) > miner.trust.probability && miner.trust.check_height !== job.height) {
        try {
            hash = new Buffer(resultHash, 'hex');
        } catch (err) {
            return invalid_share(miner);
        }
        shareType = true;
    } else { // verify share
        if (miner.payout in minerWallets && ++minerWallets[miner.payout].last_ver_shares >= MAX_VER_SHARES_PER_SEC * VER_SHARES_PERIOD) {
            if (minerWallets[miner.payout].last_ver_shares === MAX_VER_SHARES_PER_SEC * VER_SHARES_PERIOD) {
                console.error(threadName + "Throttled down miner share (diff " + job.difficulty + ") submission from " + miner.logString);
            }
            process.send({type: 'throttledShare'});
            addProxyMiner(miner);
            miner.updateDifficulty();
            return null;
        }
        shareBuffer = getShareBuffer(miner, job, blockTemplate, params);
        if (shareBuffer === null) return invalid_share(miner);
        let convertedBlob = global.coinFuncs.convertBlob(shareBuffer, blockTemplate.port);
        hash = global.coinFuncs.cryptoNight(convertedBlob, blockTemplate.port, blockTemplate.height);

        if (hash.toString('hex') !== resultHash) {
            let time_now = Date.now();
            if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 30*1000) {
                console.error(threadName + "Bad share from miner (diff " + job.difficulty + ") " + miner.logString + (miner.trust.probability == 256 ? " [banned]" : ""));
                lastMinerLogTime[miner.payout] = time_now;
            }
            return invalid_share(miner);
        }

        ++ walletTrust[miner.payout];
        shareType = false;
    }

    let hashArray = hash.toByteArray().reverse();
    let hashNum   = bignum.fromBuffer(new Buffer(hashArray));
    let hashDiff  = baseDiff.div(hashNum);

    let is_block_diff_matched = false;

    if (hashDiff.ge(blockTemplate.difficulty)) { // Submit block to the RPC Daemon.
        if (!shareBuffer) {
            shareBuffer = getShareBuffer(miner, job, blockTemplate, params);
            if (!shareBuffer) return invalid_share(miner);
        }
        submit_block(miner, job, blockTemplate, shareBuffer, true);
        is_block_diff_matched = true;
    }

/*if ("child_template" in blockTemplate) {
console.log("DEBUG: BTX");
console.log(blockTemplate.child_template_buffer);
console.log(blockTemplate.child_template_buffer.toString('hex'));
console.log(JSON.stringify(blockTemplate.child_template_buffer));
}  */

    if ("child_template" in blockTemplate && hashDiff.ge(blockTemplate.child_template.difficulty)) { // Submit child block to the RPC Daemon.
        if (!shareBuffer) {
            shareBuffer = getShareBuffer(miner, job, blockTemplate, params);
            if (!shareBuffer) return invalid_share(miner);
        }
        let shareBuffer2 = null;
        try {
console.log("DEBUG: BT");
console.log(blockTemplate.child_template_buffer);
console.log(blockTemplate.child_template_buffer.toString('hex'));
console.log(JSON.stringify(blockTemplate.child_template_buffer));
            shareBuffer2 = global.coinFuncs.constructMMChildBlockBlob(shareBuffer, blockTemplate.port, blockTemplate.child_template_buffer);
        } catch (e) {
            const err_str = "Can't construct_mm_child_block_blob with " + shareBuffer.toString('hex') + " parent block and " + blockTemplate.child_template_buffer.toString('hex') + " child block share buffers from " + miner.logString + ": " + e;
            console.error(err_str);
            global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't construct_mm_child_block_blob", err_str);
            return invalid_share(miner);
        }
        if (shareBuffer2 === null) return invalid_share(miner);
        submit_block(miner, job, blockTemplate.child_template, shareBuffer2, true);
        is_block_diff_matched = true;
    }

    if (is_block_diff_matched) { // Do nothing here

    } else if (hashDiff.lt(job.difficulty)) {
        let time_now = Date.now();
        if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 30*1000) {
           console.warn(threadName + "Rejected low diff (" + hashDiff.toString() + " < " + job.difficulty + ") share from miner " + miner.logString + (miner.trust.probability == 256 ? " [banned]" : ""));
           lastMinerLogTime[miner.payout] = time_now;
        }
        return invalid_share(miner);

    } else {
        recordShareData(miner, job, hashDiff.toString(), false, null, shareType, blockTemplate);
    }

    return true;
}

// Message times for different miner addresses
let lastMinerLogTime = {};
// Miner notification times
let lastMinerNotifyTime = {};

// Share times of miners (payout:identifier:ipAddress) that never submitted any good share
let badMinerLastShareTime = {};

function get_miner_notification(payout) {
    if (payout in notifyAddresses) return notifyAddresses[payout];
    return false;
}

function handleMinerData(method, params, ip, portData, sendReply, sendFinalReply, pushMessage) {
    // Check for ban here, so preconnected attackers can't continue to screw you
    if (ip in bannedIPs) {
        // Handle IP ban off clip.
        sendFinalReply("IP Address currently banned");
        return;
    }
    let miner;
    switch (method) {
        case 'login':
            if (!params.login) {
                sendFinalReply("No login specified");
                return;
            }
            if (!params.pass) params.pass = "x";
            let difficulty = portData.difficulty;
            let minerId = uuidV4();
            miner = new Miner(
                minerId, params.login, params.pass, ip, difficulty, pushMessage, 1, portData.portType, portData.port, params.agent,
                params.algo, params["algo-perf"], params["algo-min-time"]
            );
            if (params.agent && cluster.worker.id == 1) minerAgents[params.agent] = 1;
            let time_now = Date.now();
            if (!miner.valid_miner) {
                if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 10*60*1000) {
                    console.log("Invalid miner " + miner.logString + " [" + miner.email + "], disconnecting due to: " + miner.error);
                    lastMinerLogTime[miner.payout] = time_now;
                }
                sendFinalReply(miner.error);
                return;
            }
            let miner_id = miner.payout + ":" + miner.identifier + ":" + miner.ipAddress;
            if (miner_id in badMinerLastShareTime) {
                let ban_time_left = 3*60*1000 - (time_now - badMinerLastShareTime[miner_id]);
                if (ban_time_left > 0) {
                    sendFinalReply("You miner " + miner.identifier + " is currently banned for submitting wrong result for " + (ban_time_left / 1000) + " seconds");
                    return;
                } else {
                    debug(threadName + "Removed miner " + miner.logString + " from ban");
                    delete badMinerLastShareTime[miner_id];
                }
            }
            let miner_agent_notification = params.agent ? global.coinFuncs.get_miner_agent_notification(params.agent) : false;
            let miner_notification = miner_agent_notification ? miner_agent_notification : global.coinFuncs.get_miner_agent_warning_notification(params.agent);
            miner_notification = miner_notification ? miner_notification : get_miner_notification(miner.payout);
            if (miner_notification) {
                if (!(miner.payout in lastMinerNotifyTime) || time_now - lastMinerNotifyTime[miner.payout] > 60*60*1000) {
                    lastMinerNotifyTime[miner.payout] = time_now;
                    console.error("Sent notification to " + miner.logString + ": " + miner_notification);
                    sendFinalReply(miner_notification + " (miner will connect after several attempts)");
                    return;
                }
            }
            if (miner_agent_notification) {
                if (!(miner.payout in lastMinerNotifyTime) || time_now - lastMinerNotifyTime[miner.payout] > 60*60*1000) {
                    lastMinerNotifyTime[miner.payout] = time_now;
                    console.error("Sent notification to " + miner.logString + ": " + miner_agent_notification);
                }
                sendFinalReply(miner_agent_notification);
                return;
            }

            activeMiners.set(minerId, miner);

            if (!miner.proxy) {
                let proxyMinerName = miner.payout + ":" + miner.identifier;
                if ((params.agent && params.agent.includes('proxy')) || (proxyMinerName in proxyMiners)) {
                    addProxyMiner(miner);
                    if (proxyMiners[proxyMinerName].hashes) miner.setNewDiff(miner.calcNewDiff());
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
            sendReply(null, {
                id: minerId,
                job: miner.getJob(),
                status: 'OK'
            });
            break;
        case 'getjob':
            miner = activeMiners.get(params.id);
            if (!miner) {
                sendReply('Unauthenticated');
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
            miner.sendNewJob();
            break;
        case 'submit':
            miner = activeMiners.get(params.id);
            if (!miner) {
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();

            let job = miner.validJobs.toarray().filter(function (job) {
                return job.id === params.job_id;
            })[0];

            if (!job) {
                sendReply('Invalid job id');
                return;
            }

            params.nonce = (typeof params.nonce === 'string' ? params.nonce.substr(0, 8).toLowerCase() : "");
            if (!nonceCheck.test(params.nonce)) {
                console.warn(threadName + 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + miner.logString);
                miner.checkBan(false);
                sendReply('Duplicate share');
                global.database.storeInvalidShare(miner.invalidShareProto);
                return;
            }
            if (!miner.proxy) {
                if (params.nonce in job.submissions) {
                    console.warn(threadName + 'Duplicate share with ' + params.nonce.toString() + ' nonce from ' + miner.logString);
                    miner.checkBan(false);
                    sendReply('Duplicate share');
                    global.database.storeInvalidShare(miner.invalidShareProto);
                    return;
                }
                job.submissions[params.nonce] = 1;
            } else {
                if (!Number.isInteger(params.poolNonce) || !Number.isInteger(params.workerNonce)) {
                    console.warn(threadName + 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + miner.logString);
                    miner.checkBan(false);
                    sendReply('Duplicate share');
                    global.database.storeInvalidShare(miner.invalidShareProto);
                    return;
                }
                let nonce_test = `${params.nonce}_${params.poolNonce}_${params.workerNonce}`;
                if (nonce_test in job.submissions) {
                    console.warn(threadName + 'Duplicate proxy share with ' + nonce_test.toString() + ' nonce from ' + miner.logString);
                    miner.checkBan(false);
                    sendReply('Duplicate share');
                    global.database.storeInvalidShare(miner.invalidShareProto);
                    return;
                }
                job.submissions[nonce_test] = 1;
            }

            let blockTemplate;
            job.rewarded_difficulty = job.difficulty;

            if (activeBlockTemplates[job.coin].idHash !== job.blockHash) {
                blockTemplate = pastBlockTemplates.toarray().filter(function (t) {
                    return t.idHash === job.blockHash;
                })[0];
                let is_outdated = false;
                if (blockTemplate && blockTemplate.timeOutdate) {
                    let late_time = Date.now() - blockTemplate.timeOutdate;
                    if (late_time > 0) {
                        let max_late_time = global.config.pool.targetTime*1000;
                        if (late_time < max_late_time) {
                            let factor = (max_late_time - late_time) / max_late_time;
                            job.rewarded_difficulty = Math.floor(job.difficulty * Math.pow(factor, 6));
                            if (job.rewarded_difficulty === 0) job.rewarded_difficulty = 1;
                        } else {
                            is_outdated = true;
                        }
                    }
                }
                if (!blockTemplate || is_outdated) {
                    let err_str = is_outdated ? "Block outdated" : "Block expired";
                    let time_now = Date.now();
                    if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 30*1000) {
                        console.warn(threadName + err_str + ', Height: ' + job.height + ' (diff ' + job.difficulty + ') from ' + miner.logString);
                        lastMinerLogTime[miner.payout] = time_now;
                    }
                    miner.sendNewJob();
                    sendReply(err_str);
                    global.database.storeInvalidShare(miner.invalidShareProto);
                    return;
                }
            } else {
                blockTemplate = activeBlockTemplates[job.coin];
            }

            job.rewarded_difficulty2 = job.rewarded_difficulty * job.coinHashFactor;

            let shareAccepted = processShare(miner, job, blockTemplate, params);
            if (shareAccepted === null) {
                sendReply('Throttled down share submission (please use high fixed diff or use xmr-node-proxy)');
                return;
            }
            miner.checkBan(shareAccepted);

            if (global.config.pool.trustedMiners) {
                if (shareAccepted) {
                    miner.trust.probability -= global.config.pool.trustChange;
                    if (miner.trust.probability < (global.config.pool.trustMin)) {
                        miner.trust.probability = global.config.pool.trustMin;
                    }
                    miner.trust.penalty--;
                    miner.trust.threshold--;
                    miner.trust.check_height = 0;

                } else {
                    if (miner.trust.probability == 256) {
                        badMinerLastShareTime[miner.payout + ":" + miner.identifier + ":" + miner.ipAddress] = Date.now();
                        debug(threadName + "Banned miner for some time " + miner.logString);
                        removeMiner(miner);
                        sendReply('Low difficulty share');
                        return;
                    }
                    debug(threadName + "Share trust broken by " + miner.logString);
                    global.database.storeInvalidShare(miner.invalidShareProto);
                    miner.trust.probability = 256;
                    miner.trust.penalty     = global.config.pool.trustPenalty;
                    miner.trust.threshold   = global.config.pool.trustThreshold;
                }
            }

            if (!shareAccepted) {
                sendReply('Low difficulty share');
                return;
            }

            miner.lastShareTime = Date.now() / 1000 || 0;

            sendReply(null, {status: 'OK'});
            break;
        case 'keepalived':
            miner = activeMiners.get(params.id);
            if (!miner) {
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            sendReply(null, {
                status: 'KEEPALIVED'
            });
            break;
    }
}

if (global.config.general.allowStuckPoolKill && fs.existsSync("block_template_is_stuck")) {
   console.error("Stuck block template was detected on previous run. Please fix monerod and remove block_template_is_stuck file after that. Exiting...");
   setTimeout(function() { process.exit(); }, 5*1000);
   return;
}

setInterval(function dump_vars() {
   const fn = "dump" + (cluster.isMaster ? "" : "_" + cluster.worker.id.toString());
   fs.access(fn, fs.F_OK, function(err) {
      if (!err) return;
      console.log("DUMPING VARS TO " + fn + " FILE");
      let s = fs.createWriteStream(fn, {'flags': 'a'});

      s.write("activeMiners:\n");
      for (var [minerId, miner] of activeMiners) s.write(minerId + ": " + JSON.stringify(miner, null, '\t') + "\n");

      s.write("\n\n\npastBlockTemplates:\n");
      pastBlockTemplates.toarray().forEach(function(v) { s.write(JSON.stringify(v, null, '\t') + "\n"); });

      s.write("\n\n\nlastBlockHash:\n");
      s.write(JSON.stringify(lastBlockHash, null, '\t') + "\n");

      s.write("\n\n\nlastCoinHashFactor:\n");
      s.write(JSON.stringify(lastCoinHashFactor, null, '\t') + "\n");

      s.write("\n\n\ncurrCoinHashFactor:\n");
      s.write(JSON.stringify(currCoinHashFactor, null, '\t') + "\n");

      s.write("\n\n\ncurrCoinHashFactorMM:\n");
      s.write(JSON.stringify(currCoinHashFactorMM, null, '\t') + "\n");

      s.write("\n\n\nactiveBlockTemplate:\n");
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

                       global.support.sendEmail(global.config.general.adminEmail,
                           "Pool server " + global.config.hostname + " has stuck block template",
                           "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " with current block height " +
                           height + " is stuck compared to top height (" + top_height + ") amongst other leaf nodes for " +
                           port + " port\nAttempting to fix..."
                       );
                       if (fs.existsSync(fix_daemon_sh)) {
                           child_process.exec(fix_daemon_sh + " " + port, function callback(error, stdout, stderr) {
                               console.log("> " + fix_daemon_sh + " " + port);
                               console.log(stdout);
                               console.error(stderr);
                               if (error) console.error(fix_daemon_sh + " script returned error exit code: " + error.code);
                           });
                       } else {
	                   console.error("No " + fix_daemon_sh + " script was found to fix stuff");
                       }
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
        let worker = cluster.fork();
        worker.on('message', messageHandler);
    }

    cluster.on('online', function (worker) {
        console.log('Worker ' + worker.process.pid + ' is online');
    });

    cluster.on('exit', function (worker, code, signal) {
        console.log('Worker ' + worker.process.pid + ' died with code: ' + code + ', and signal: ' + signal);
        console.log('Starting a new worker');
        worker = cluster.fork();
        worker.on('message', messageHandler);
        global.support.sendEmail(global.config.general.adminEmail, "FYI: Started new worker " + worker.id,
            "Hello,\r\nMaster theread starts new worker with id " + worker.id);
    });


    if (!global.config.daemon.activePort) {
        console.warn("global.config.daemon.activePort is not defined, using fixed global.config.daemon.port instead");
        global.config.daemon.activePort = global.config.daemon.port;
    } else {
        currCoinHashFactor[""] = currCoinHashFactorMM[""] = 1;
        setInterval(updateActivePort, 3*1000, "");
        if (global.config.daemon.enableAlgoSwitching) COINS.forEach(function(coin) {
            currCoinHashFactor[coin] = currCoinHashFactorMM[coin] = 0;
            if ("activePort" + coin in global.config.daemon) {
                setInterval(updateActivePort, 5*1000, coin);
                templateUpdate(coin);
                setTimeout(templateUpdate, 50, coin, true);
            } else {
                console.warn("global.config.daemon." + "activePort" + coin + " is not defined, so ignoring its coin changes");
            }
        });
    }

    templateUpdate("");
    setTimeout(templateUpdate, 50, "", true);
    global.support.sendEmail(global.config.general.adminEmail, "Pool server " + global.config.hostname + " online", "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " is online");

} else {
    currCoinHashFactor[""] = currCoinHashFactorMM[""] = 1;
    templateUpdate("");
    if (global.config.daemon.enableAlgoSwitching) COINS.forEach(function(coin) {
        currCoinHashFactor[coin] = currCoinHashFactorMM[coin] = 0;
        if ("activePort" + coin in global.config.daemon) templateUpdate(coin);
    });
    anchorBlockUpdate();
    setInterval(anchorBlockUpdate, 3*1000);
    setInterval(checkAliveMiners, 60*1000);
    setInterval(retargetMiners, global.config.pool.retargetTime * 1000);
    setInterval(function () {
        bannedIPs = {};
    }, 60*1000);

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
       const fn = "wallet_trust_" + cluster.worker.id.toString();
       fs.writeFile(fn, str, function(err) { if (err) console.error("Error saving " + fn + " file"); });

       if (cluster.worker.id == 1) {
           let str2 = "";
           for (let agent in minerAgents) { str2 += agent + "\n"; }
           const fn2 = "miner_agents";
           fs.writeFile(fn2, str2, function(err) { if (err) console.error("Error saving " + fn2 + " file"); });
       }

    }, 10*60*1000);

    let lastGarbageFromIpTime = {};

    async.each(global.config.ports, function (portData) {
        if (global.config[portData.portType].enable !== true) {
            return;
        }
        let handleMessage = function (socket, jsonData, pushMessage) {
            if (!jsonData.id) {
                console.warn('Miner RPC request missing RPC id');
                return;
            }
            else if (!jsonData.method) {
                console.warn('Miner RPC request missing RPC method');
                return;
            }
            else if (!jsonData.params) {
                console.warn('Miner RPC request missing RPC params');
                return;
            }

            let sendReply = function (error, result) {
                if (!socket.writable) {
                    return;
                }
                let sendData = JSON.stringify({
                        id: jsonData.id,
                        jsonrpc: "2.0",
                        error: error ? {code: -1, message: error} : null,
                        result: result
                    }) + "\n";
                socket.write(sendData);
            };
            let sendFinalReply = function (error) {
                let sendData = JSON.stringify({
                        id: jsonData.id,
                        jsonrpc: "2.0",
                        error: {code: -1, message: error},
                        result: null
                    }) + "\n";
                socket.end(sendData);
            };
            handleMinerData(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, sendFinalReply, pushMessage);
        };

        function socketConn(socket) {
            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            let dataBuffer = '';

            let pushMessage = function (method, params) {
                if (!socket.writable) {
                    return;
                }
                let sendData = JSON.stringify({
                        jsonrpc: "2.0",
                        method: method,
                        params: params
                    }) + "\n";
                socket.write(sendData);
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
                if (err.code !== 'ECONNRESET') {
                    console.warn(threadName + "Socket Error from " + socket.remoteAddress + " Error: " + err);
                }
            }).on('close', function () {
                pushMessage = function () {
                };
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
}
