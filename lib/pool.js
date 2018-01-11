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

let nonceCheck = new RegExp("^[0-9a-f]{8}$");
let bannedIPs = [];
let bannedAddresses = [];
let baseDiff = global.coinFuncs.baseDiff();
let pastBlockTemplates = global.support.circularBuffer(4);
let activeMiners = [];
let activeBlockTemplate;
let lastBlockTemplateUpdateTime;
let lastBlockHash;
let lastBlockHashUpdateTime;
let workerList = [];
let httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 18\n\nMining Pool Online';
let threadName;
let minerCount = [];
let BlockTemplate = global.coinFuncs.BlockTemplate;
let hexMatch = new RegExp("^[0-9a-f]+$");
let totalShares = 0, trustedShares = 0, normalShares = 0, invalidShares = 0;

Buffer.prototype.toByteArray = function () {
    return Array.prototype.slice.call(this, 0);
};


if (cluster.isMaster) {
    threadName = "(Master) ";
    setInterval(function () {
        console.log(`Processed ${trustedShares}/${normalShares}/${invalidShares}/${totalShares} Trusted/Validated/Invalid/Total shares in the last 30 seconds`);
        totalShares = 0;
        trustedShares = 0;
        normalShares = 0;
        invalidShares = 0;
    }, 30000);
} else {
    threadName = "(Worker " + cluster.worker.id + " - " + process.pid + ") ";
}

global.database.thread_id = threadName;

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
                bannedIPs.push(message.data);
            }
            break;
        case 'newBlockTemplate':
            debug(threadName + "Received new block template");
            if (cluster.isMaster) {
                sendToWorkers(message);
                newBlockTemplate(message.data);
            } else {
                newBlockTemplate(message.data);
            }
            break;
        case 'removeMiner':
            if (cluster.isMaster) {
                minerCount[message.data] -= 1;
            }
            break;
        case 'newMiner':
            if (cluster.isMaster) {
                minerCount[message.data] += 1;
            }
            break;
        case 'sendRemote':
            if (cluster.isMaster) {
                global.database.sendQueue.push({body: Buffer.from(message.body, 'hex')});
            }
            break;
        case 'trustedShare':
            trustedShares += 1;
            totalShares += 1;
            break;
        case 'normalShare':
            normalShares += 1;
            totalShares += 1;
            break;
        case 'invalidShare':
            invalidShares += 1;
            totalShares += 1;
    }
}

process.on('message', messageHandler);

function sendToWorkers(data) {
    workerList.forEach(function (worker) {
        worker.send(data);
    });
}

function retargetMiners() {
    debug(threadName + "Performing difficulty check on miners");
    console.log('Performing difficulty update on miners');
    for (let minerId in activeMiners) {
        if (activeMiners.hasOwnProperty(minerId)) {
            let miner = activeMiners[minerId];
            if (!miner.fixed_diff) {
                miner.updateDifficulty();
            }
        }
    }
}

function checkAliveMiners() {
    debug(threadName + "Verifying if miners are still alive");
    for (let minerId in activeMiners) {
        if (activeMiners.hasOwnProperty(minerId)) {
            let miner = activeMiners[minerId];
            if (Date.now() - miner.lastContact > global.config.pool.minerTimeout * 1000) {
                process.send({type: 'removeMiner', data: miner.port});
                delete activeMiners[minerId];
            }
        }
    }
}

function templateUpdateReal() {
    global.coinFuncs.getBlockTemplate(global.config.pool.address, function (rpcResponse) {
        if (rpcResponse && typeof rpcResponse.result !== 'undefined') {
            rpcResponse = rpcResponse.result;
            let buffer = new Buffer(rpcResponse.blocktemplate_blob, 'hex');
            let new_hash = new Buffer(32);
            buffer.copy(new_hash, 0, 7, 39);
            if (!activeBlockTemplate || new_hash.toString('hex') !== activeBlockTemplate.previous_hash.toString('hex')) {
                debug(threadName + "New block template found at " + rpcResponse.height + " height with hash: " + new_hash.toString('hex'));
                if (cluster.isMaster) {
                    sendToWorkers({type: 'newBlockTemplate', data: rpcResponse});
                    newBlockTemplate(rpcResponse);
                } else {
                    process.send({type: 'newBlockTemplate', data: rpcResponse});
                    newBlockTemplate(rpcResponse);
                }
            }
        } else {
            console.error("Block template request failed!");
            setTimeout(templateUpdateReal, 3000);
        }
    });
}

function templateUpdate(repeating) {
    if (lastBlockHashUpdateTime && Date.now() - lastBlockHashUpdateTime > 30*60*1000) {
        console.error("Block height was not updated for half an hour. Check your monerod. Exiting...");
        fs.closeSync(fs.openSync("block_template_is_stuck", 'w'));
        process.exit();
    }
    global.coinFuncs.getLastBlockHeader(function (err, body) {
        if (err === null) {
            let time_now = Date.now();
            let is_block_hash_updated = !lastBlockHash || body.hash !== lastBlockHash;
            if (is_block_hash_updated || !lastBlockTemplateUpdateTime || time_now - lastBlockTemplateUpdateTime > 10*1000) {
                if (is_block_hash_updated) lastBlockHashUpdateTime = time_now;
                lastBlockHash = body.hash;
                lastBlockTemplateUpdateTime = time_now;
                templateUpdateReal();
            }
            if (repeating === true) setTimeout(templateUpdate, 100, repeating);
        } else {
            console.error("Last block header request failed!");
            setTimeout(templateUpdate, 1000, repeating);
        }
    });
}

function newBlockTemplate(template) {
    //let buffer = new Buffer(template.blocktemplate_blob, 'hex');
    //let previous_hash = new Buffer(32);
    //buffer.copy(previous_hash, 0, 7, 39);
    console.log(threadName + 'New block to mine at height: ' + template.height + '.  Difficulty: ' + template.difficulty);
    if (activeBlockTemplate) {
        pastBlockTemplates.enq(activeBlockTemplate);
    }
    activeBlockTemplate = new BlockTemplate(template);
    for (let minerId in activeMiners) {
        if (activeMiners.hasOwnProperty(minerId)) {
            let miner = activeMiners[minerId];
            debug(threadName + "Updating worker " + miner.payout + " With new work at height: " + template.height);
            miner.sendNewJob();
        }
    }
}

let VarDiff = (function () {
    let variance = global.config.pool.varDiffVariance / 100 * global.config.pool.targetTime;
    return {
        tMin: global.config.pool.targetTime - variance,
        tMax: global.config.pool.targetTime + variance
    };
})();

// here we keep verified share number of a specific wallet (miner.payout)
// it will reset to 0 after invalid share is found
// if walletTrust exceeds certain threshold (global.config.pool.trustThreshold * 100) then low diff (<=16000) new workers for this wallet are started with high trust
// this is needed to avoid CPU overload after constant miner reconnections that happen during mining botnet swarms
let walletTrust = {};
// wallet last seen time (all wallets that are not detected for more than 1 day are removed)
let walletLastSeeTime = {};

var reEmail = /^\S+@\S+\.\S+$/;
// wallet password last check time
let walletLastCheckTime = {};

function Miner(id, login, pass, ipAddress, startingDiff, messageSender, protoVersion, portType, port, agent) {
    // Username Layout - <address in BTC or XMR>.<Difficulty>
    // Password Layout - <password>.<miner identifier>.<payment ID for XMR>
    // Default function is to use the password so they can login.  Identifiers can be unique, payment ID is last.
    // If there is no miner identifier, then the miner identifier is set to the password
    // If the password is x, aka, old-logins, we're not going to allow detailed review of miners.

    // Miner Variables
    let pass_split = pass.split(":");
    // Workaround for a common mistake to put email without : before it
    // and also security measure to hide emails used as worker names
    if (pass_split.length === 1 && reEmail.test(pass_split[0])) {
        pass_split.push(pass_split[0]);
        pass_split[0] = "email";
    }
    this.error = "";
    this.identifier = pass_split[0];
    this.proxy = false;
    if (agent && agent.includes('MinerGate')) {
        this.identifier = "MinerGate";
    }
    if (agent && agent.includes('xmr-node-proxy')) {
        this.proxy = true;
    }
    this.paymentID = null;
    this.valid_miner = true;
    this.port = port;
    this.portType = portType;
    this.incremented = false;
    switch (portType) {
        case 'pplns':
            this.poolTypeEnum = global.protos.POOLTYPE.PPLNS;
            break;
        case 'pps':
            this.poolTypeEnum = global.protos.POOLTYPE.PPS;
            break;
        case 'solo':
            this.poolTypeEnum = global.protos.POOLTYPE.SOLO;
            break;
        case 'prop':
            this.poolTypeEnum = global.protos.POOLTYPE.PROP;
            break;
    }
    let diffSplit = login.split("+");
    let addressSplit = diffSplit[0].split('.');
    this.address = addressSplit[0];
    this.payout = addressSplit[0];
    this.fixed_diff = false;
    this.difficulty = startingDiff;
    this.connectTime = Date.now();
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
    } else if (diffSplit.length > 2) {
        this.error = "Too many options in the login field";
        this.valid_miner = false;
    }
    if (typeof(addressSplit[1]) !== 'undefined' && addressSplit[1].length === 64 && hexMatch.test(addressSplit[1])) {
        this.paymentID = addressSplit[1];
        this.payout = this.address + "." + this.paymentID;
    } else if (typeof(addressSplit[1]) !== 'undefined') {
        this.identifier = pass_split[0] === 'x' ? addressSplit[1] : pass_split[0];
    }
    if (typeof(addressSplit[2]) !== 'undefined') {
        this.identifier = pass_split[0] === 'x' ? addressSplit[2] : pass_split[0];
    }

    if (pass_split.length === 2) {
        /*
         Email address is: pass_split[1]
         Need to do an initial registration call here.  Might as well do it right...
         */
        let payoutAddress = this.payout;
        let time_now = Date.now();
        if (!(payoutAddress in walletLastCheckTime) || time_now - walletLastCheckTime[payoutAddress] > 60*1000) {
            global.mysql.query("SELECT id FROM users WHERE username = ? LIMIT 1", [this.payout]).then(function (rows) {
                if (rows.length > 0) {
                    return;
                }
                if (global.coinFuncs.blockedAddresses.indexOf(payoutAddress) !== -1) {
                    return;
                }
                global.mysql.query("INSERT INTO users (username, email) VALUES (?, ?)", [payoutAddress, pass_split[1]]);
            });
            walletLastCheckTime[payoutAddress] = time_now;
        }
    } else if (pass_split.length > 2) {
        this.error = "Too many options in the password field";
        this.valid_miner = false;
    }

    if (global.coinFuncs.validateAddress(this.address)) {
        this.bitcoin = 0;
    } else if (btcValidator.validate(this.address) && global.config.general.allowBitcoin && global.coinFuncs.supportsAutoExchange) {
        this.bitcoin = 1;
    } else if (btcValidator.validate(this.address)) {
        this.error = "This pool does not allow payouts to bitcoin.";
        this.valid_miner = false;
    } else {
        // Invalid Addresses
        this.error = "Invalid payment address provided";
        this.valid_miner = false;
    }
    if (bannedAddresses.indexOf(this.address) !== -1) {
        // Banned Address
        this.error = "Banned payment address provided";
        this.valid_miner = false;
    }
    if (global.coinFuncs.exchangeAddresses.indexOf(this.address) !== -1 && !(this.paymentID)) {
        this.error = "Exchange addresses need payment IDs";
        this.valid_miner = false;
    }
    if (!activeBlockTemplate) {
        this.error = "No active block template";
        this.valid_miner = false;
    }

    this.id = id;
    this.ipAddress = ipAddress;
    this.messageSender = messageSender;
    this.heartbeat = function () {
        this.lastContact = Date.now();
    };
    this.heartbeat();

    // VarDiff System
    this.shareTimeBuffer = global.support.circularBuffer(8);
    this.shareTimeBuffer.enq(global.config.pool.targetTime);
    this.lastShareTime = Date.now() / 1000 || 0;

    this.validShares = 0;
    this.invalidShares = 0;
    this.hashes = 0;
    this.logString = this.address + " ID: " + this.identifier + " IP: " + this.ipAddress;

    if (global.config.pool.trustedMiners) {
        if (!(this.payout in walletTrust)) {
            walletTrust[this.payout] = 0;
            walletLastSeeTime[this.payout] = Date.now();
        }
        let is_trusted_wallet = this.difficulty <= 16001 && this.payout in walletTrust && walletTrust[this.payout] > global.config.pool.trustThreshold * 20;
        this.trust = {
            threshold:   is_trusted_wallet ? 1 : global.config.pool.trustThreshold,
            probability: is_trusted_wallet ? global.config.pool.trustMin : 256,
            penalty: 0
        };
    }

    this.validJobs = global.support.circularBuffer(4);
    this.sentJobs = global.support.circularBuffer(8);

    this.cachedJob = null;

    this.invalidShareProto = global.protos.InvalidShare.encode({
        paymentAddress: this.address,
        paymentID: this.paymentID,
        identifier: this.identifier.substring(0, 64)
    });

    // Support functions for how miners activate and run.
    this.updateDifficultyOld = function () {
        let now = Math.round(Date.now() / 1000);
        let avg = this.shareTimeBuffer.average(this.lastShareTime);

        let sinceLast = now - this.lastShareTime;
        let decreaser = sinceLast > VarDiff.tMax;

        let newDiff;
        let direction;

        if (avg > VarDiff.tMax && this.difficulty > global.config.pool.minDifficulty) {
            newDiff = global.config.pool.targetTime / avg * this.difficulty;
            direction = -1;
        }
        else if (avg < VarDiff.tMin && this.difficulty < global.config.pool.maxDifficulty) {
            newDiff = global.config.pool.targetTime / avg * this.difficulty;
            direction = 1;
        }
        else {
            return;
        }

        if (Math.abs(newDiff - this.difficulty) / this.difficulty * 100 > global.config.pool.maxDiffChange) {
            let change = global.config.pool.maxDiffChange / 100 * this.difficulty * direction;
            newDiff = this.difficulty + change;
        }

        this.setNewDiff(newDiff);
        this.shareTimeBuffer.clear();
        if (decreaser) {
            this.lastShareTime = now;
        }
    };

    this.updateDifficulty = function () {
        if (this.hashes > 0) {
            let newDiff = 0;
            if (this.proxy) {
                newDiff = Math.floor(Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000)))* 5);
            } else {
                newDiff = Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) * global.config.pool.targetTime;
            }
            this.setNewDiff(newDiff);
        } else {
            this.updateDifficultyOld();
        }
    };

    this.setNewDiff = function (difficulty) {
        this.newDiff = Math.round(difficulty);
        debug(threadName + "Difficulty: " + this.newDiff + " For: " + this.logString + " Time Average: " + this.shareTimeBuffer.average(this.lastShareTime) + " Entries: " + this.shareTimeBuffer.size() + "  Sum: " + this.shareTimeBuffer.sum());
        if (this.newDiff > global.config.pool.maxDifficulty && !this.proxy) {
            this.newDiff = global.config.pool.maxDifficulty;
        }
        if (this.difficulty === this.newDiff) {
            return;
        }
        if (this.newDiff < global.config.pool.minDifficulty) {
            this.newDiff = global.config.pool.minDifficulty;
        }
        debug(threadName + "Difficulty change to: " + this.newDiff + " For: " + this.logString);
        if (this.hashes > 0) {
            debug(threadName + "Hashes: " + this.hashes + " in: " + Math.floor((Date.now() - this.connectTime) / 1000) + " seconds gives: " +
                Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) + " hashes/second or: " +
                Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) * global.config.pool.targetTime + " difficulty versus: " + this.newDiff);
        }
        this.sendNewJob();
    };

    this.checkBan = function (validShare) {
        if (!global.config.pool.banEnabled) {
            return;
        }

        // Valid stats are stored by the pool.
        if (validShare) {
            this.validShares += 1;
        } else {
            this.invalidShares += 1;
        }
        if (this.validShares + this.invalidShares >= global.config.pool.banThreshold) {
            if (this.invalidShares / this.validShares >= global.config.pool.banPercent / 100) {
                delete activeMiners[this.id];
                process.send({type: 'banIP', data: this.ipAddress});
            }
            else {
                this.invalidShares = 0;
                this.validShares = 0;
            }
        }
    };

    if (protoVersion === 1) {
        this.getTargetHex = function () {
            if (this.newDiff) {
                this.difficulty = this.newDiff;
                this.newDiff = null;
            }
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
        this.getJob = function () {

            if (this.lastBlockHeight === activeBlockTemplate.height && activeBlockTemplate.idHash === this.validJobs.get(0).blockHash && !this.newDiff && this.cachedJob !== null) {
                return this.cachedJob;
            }

            if (!this.proxy) {
                let blob = activeBlockTemplate.nextBlob();
                let target = this.getTargetHex();
                this.lastBlockHeight = activeBlockTemplate.height;


                let newJob = {
                    id: crypto.pseudoRandomBytes(21).toString('base64'),
                    extraNonce: activeBlockTemplate.extraNonce,
                    height: activeBlockTemplate.height,
                    difficulty: this.difficulty,
                    diffHex: this.diffHex,
                    submissions: [],
                    blockHash: activeBlockTemplate.idHash
                };

                this.validJobs.enq(newJob);
                this.cachedJob = {
                    blob: blob,
                    job_id: newJob.id,
                    target: target,
                    id: this.id
                };
            } else {
                let blob = activeBlockTemplate.nextBlobWithChildNonce();
                if (this.newDiff) {
                    this.difficulty = this.newDiff;
                    this.newDiff = null;
                }
                this.lastBlockHeight = activeBlockTemplate.height;

                let newJob = {
                    id: crypto.pseudoRandomBytes(21).toString('base64'),
                    extraNonce: activeBlockTemplate.extraNonce,
                    height: activeBlockTemplate.height,
                    difficulty: this.difficulty,
                    diffHex: this.diffHex,
                    clientPoolLocation: activeBlockTemplate.clientPoolLocation,
                    clientNonceLocation: activeBlockTemplate.clientNonceLocation,
                    submissions: []
                };
                this.validJobs.enq(newJob);
                this.cachedJob = {
                    blocktemplate_blob: blob,
                    difficulty: activeBlockTemplate.difficulty,
                    height: activeBlockTemplate.height,
                    reserved_offset: activeBlockTemplate.reserveOffset,
                    client_nonce_offset: activeBlockTemplate.clientNonceLocation,
                    client_pool_offset: activeBlockTemplate.clientPoolLocation,
                    target_diff: this.difficulty,
                    target_diff_hex: this.diffHex,
                    job_id: newJob.id,
                    id: this.id
                };
            }
            return this.cachedJob;
        };

        this.sendNewJob = function() {
            let job = this.getJob();
            let tempJob = this.sentJobs.toarray().filter(function (intJob) {
                return intJob.id === job.job_id;
            })[0];

            if (tempJob) {
                console.error(`Tried sending a duped job to: ${this.address}, stopped by Snipa!`);
                return;
            }
            this.sentJobs.enq(job);
            return this.messageSender('job', job);
        };
    }
}

// store wallet_key (address, paymentID, bitcoin, poolTypeEnum) -> worker_name -> shareType -> (height, difficulty, time, acc)
let walletAcc             = {};
// number of worker_name for wallet_key (so we do not count them by iteration)
let walletWorkerCount     = {};
// is share finalizer function for dead worker_name is active
let is_walletAccFinalizer = {};

function walletAccFinalizer(wallet_key, miner_address, miner_paymentID, miner_bitcoin, miner_poolTypeEnum) {
    //console.log("!!! " + wallet_key + ": scanning for old worker names");
    let wallet = walletAcc[wallet_key];
    let is_something_left = false;
    let time_now = Date.now();
    for (let worker_name in wallet) {
        let worker = wallet[worker_name];
        if (time_now - worker["time"] > 60*1000) {
            let acc = worker["acc"];
            if (acc != 0) {
                let height = worker["height"];
                //console.log("!!! " + wallet_key + " / " + worker_name  + ": storing old worker share " + height + " " + worker["difficulty"] + " " + time_now + " " + acc);
                global.database.storeShare(height, global.protos.Share.encode({
                    shares: acc,
                    paymentAddress: miner_address,
                    paymentID: miner_paymentID,
                    foundBlock: false,
                    trustedShare: true,
                    poolType: miner_poolTypeEnum,
                    poolID: global.config.pool_id,
                    blockDiff: worker["difficulty"],
                    bitcoin: miner_bitcoin,
                    blockHeight: height,
                    timestamp: time_now,
                    identifier: worker_name
                }));
            }
            //console.log("!!! " + wallet_key + ": removing old worker " + worker_name);
            if (worker_name !== "all_other_workers") -- walletWorkerCount[wallet_key];
            delete wallet[worker_name];
        } else {
            is_something_left = true;
        }
    }

    if (is_something_left) {
        setTimeout(walletAccFinalizer, 60*1000, wallet_key, miner_address, miner_paymentID, miner_bitcoin, miner_poolTypeEnum);
    } else {
        is_walletAccFinalizer[wallet_key] = false;
    }
}

function recordShareData(miner, job, shareDiff, blockCandidate, hashHex, shareType, blockTemplate) {
    miner.hashes += job.difficulty;

    let safe_worker_name = miner.identifier.substring(0, 64);

    let time_now = Date.now();
    let wallet_key = miner.address + " " + miner.paymentID + " " + miner.bitcoin + " " + miner.poolTypeEnum;

    if (!(wallet_key in walletAcc)) {
        walletAcc[wallet_key] = {};
        walletWorkerCount[wallet_key] = 0;
        is_walletAccFinalizer[wallet_key] = false;
    }

    if (job.difficulty >= 1000000 || blockCandidate) {

        global.database.storeShare(job.height, global.protos.Share.encode({
            shares: job.difficulty,
            paymentAddress: miner.address,
            paymentID: miner.paymentID,
            foundBlock: blockCandidate,
            trustedShare: shareType,
            poolType: miner.poolTypeEnum,
            poolID: global.config.pool_id,
            blockDiff: activeBlockTemplate.difficulty,
            bitcoin: miner.bitcoin,
            blockHeight: job.height,
            timestamp: time_now,
            identifier: safe_worker_name
        }));

    } else {
    
        let wallet = walletAcc[wallet_key];
    
        let worker_name = safe_worker_name in wallet || walletWorkerCount[wallet_key] < 50 ? safe_worker_name : "all_other_workers";
    
        if (!(worker_name in wallet)) {
            if (worker_name !== "all_other_workers") ++ walletWorkerCount[wallet_key];
            //console.log("!!! " + wallet_key + ": adding new worker " + worker_name + " (num " + walletWorkerCount[wallet_key] + ")");
            wallet[worker_name] = {};
            let worker = wallet[worker_name];
            worker["height"]     = job.height;
            worker["difficulty"] = activeBlockTemplate.difficulty;
            worker["time"]       = time_now;
            worker["acc"]        = 0;
        }
    
        let worker = wallet[worker_name];
    
        let height     = worker["height"];
        let difficulty = worker["difficulty"];
        let acc        = worker["acc"];
    
        if (height !== job.height || difficulty !== activeBlockTemplate.difficulty || time_now - worker["time"] > 60*1000 || acc >= 1000000) {
            if (acc != 0) {
                //console.log("!!! " + wallet_key + " / " + worker_name  + ": storing share " + height + " " + difficulty + " " + time_now + " " + acc);
                global.database.storeShare(height, global.protos.Share.encode({
                    shares: acc,
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
                    identifier: worker_name
                }));
            }
    
            worker["height"]     = job.height;
            worker["difficulty"] = activeBlockTemplate.difficulty;
            worker["time"]       = time_now;
            worker["acc"]        = job.difficulty;
    
        } else {
            worker["acc"] += job.difficulty;
        }
    
        //console.log("!!! " + wallet_key + " / " + worker_name  + ": accumulating share " + job.height + " " + activeBlockTemplate.difficulty + " " + worker["time"] + " " + worker["acc"] + " (+" +  job.difficulty + ")");
    }

    if (is_walletAccFinalizer[wallet_key] === false) {
        is_walletAccFinalizer[wallet_key] = true;
        setTimeout(walletAccFinalizer, 60*1000, wallet_key, miner.address, miner.paymentID, miner.bitcoin, miner.poolTypeEnum);
    }

    if (blockCandidate) {
        global.database.storeBlock(job.height, global.protos.Block.encode({
            hash: hashHex,
            difficulty: blockTemplate.difficulty,
            shares: 0,
            timestamp: Date.now(),
            poolType: miner.poolTypeEnum,
            unlocked: false,
            valid: true
        }));
    }
    if (shareType) {
        process.send({type: 'trustedShare'});
        debug(threadName + "Accepted trusted share at difficulty: " + job.difficulty + "/" + shareDiff + " from: " + miner.logString);
    } else {
        process.send({type: 'normalShare'});
        debug(threadName + "Accepted valid share at difficulty: " + job.difficulty + "/" + shareDiff + " from: " + miner.logString);
    }

}

function processShare(miner, job, blockTemplate, params) {
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
    let shareBuffer = global.coinFuncs.constructNewBlob(template, new Buffer(nonce, 'hex'));

    let convertedBlob;
    let hash;
    let shareType;

    if (global.config.pool.trustedMiners && miner.difficulty < 400000 && miner.trust.threshold <= 0 && miner.trust.penalty <= 0 &&
        crypto.randomBytes(1).readUIntBE(0, 1) > miner.trust.probability) {
        hash = new Buffer(resultHash, 'hex');
        shareType = true;
    }
    else {
        convertedBlob = global.coinFuncs.convertBlob(shareBuffer);
        hash = global.coinFuncs.cryptoNight(convertedBlob);
        shareType = false;
        ++ walletTrust[miner.payout];
        walletLastSeeTime[miner.payout] = Date.now();
    }
    if (hash.toString('hex') !== resultHash) {
        console.error(threadName + "Bad share from miner " + miner.logString);
        process.send({type: 'invalidShare'});
        if (miner.incremented === false) {
            miner.newDiff = miner.difficulty + 1;
            miner.incremented = true;
        } else {
            miner.newDiff = miner.difficulty - 1;
            miner.incremented = false;
        }
	miner.sendNewJob();
        walletTrust[miner.payout] = 0;
        walletLastSeeTime[miner.payout] = Date.now();
        return false;
    }

    let hashArray = hash.toByteArray().reverse();
    let hashNum = bignum.fromBuffer(new Buffer(hashArray));
    let hashDiff = baseDiff.div(hashNum);


    if (hashDiff.ge(blockTemplate.difficulty)) {
        // Submit block to the RPC Daemon.
        // Todo: Implement within the coins/<coin>.js file.
        global.support.rpcDaemon('submitblock', [shareBuffer.toString('hex')], function (rpcResult) {
            if (rpcResult.error) {
                // Did not manage to submit a block.  Log and continue on.
                console.error(threadName + "Error submitting block at height " + job.height + " from " + miner.logString + ", share type: " + shareType + " error: " + JSON.stringify(rpcResult.error));
                recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
                // Error on submit, so we'll submit a sanity check for good measure.
                templateUpdate();
            } else if (rpcResult) {
                //Success!  Submitted a block without an issue.
                let blockFastHash = global.coinFuncs.getBlockID(shareBuffer).toString('hex');
                console.log(threadName + "Block " + blockFastHash.substr(0, 6) + " found at height " + job.height + " by " + miner.logString +
                    ", share type: " + shareType + " - submit result: " + JSON.stringify(rpcResult.result));
                recordShareData(miner, job, hashDiff.toString(), true, blockFastHash, shareType, blockTemplate);
                templateUpdate();
            } else {
                // RPC bombed out massively.
                console.error(threadName + "RPC Error.  Please check logs for details");
            }
        });
    }
    else if (hashDiff.lt(job.difficulty)) {
        process.send({type: 'invalidShare'});
        console.warn(threadName + "Rejected low diff share of " + hashDiff.toString() + " from: " + miner.address + " ID: " +
            miner.identifier + " IP: " + miner.ipAddress);
        return false;
    }
    else {
        recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
    }
    return true;
}

let lastMessageTime;

function handleMinerData(method, params, ip, portData, sendReply, pushMessage) {
    let miner = activeMiners[params.id];
    // Check for ban here, so preconnected attackers can't continue to screw you
    if (bannedIPs.indexOf(ip) !== -1) {
        // Handle IP ban off clip.
        sendReply("IP Address currently banned");
        return;
    }
    switch (method) {
        case 'login':
            if (!params.login || (!params.pass && params.agent && !params.agent.includes('MinerGate'))) {
                sendReply("No login/password specified");
                return;
            }
            let difficulty = portData.difficulty;
            let minerId = uuidV4();
            miner = new Miner(minerId, params.login, params.pass, ip, difficulty, pushMessage, 1, portData.portType, portData.port, params.agent);
            if (!miner.valid_miner) {
                let time_now = Date.now();
                if (!lastMessageTime || time_now - lastMessageTime > 30*1000) {
                    console.log("Invalid miner, disconnecting due to: " + miner.error);
                    lastMessageTime = time_now;
                }
                sendReply(miner.error);
                return;
            }
            process.send({type: 'newMiner', data: miner.port});
            activeMiners[minerId] = miner;
            sendReply(null, {
                id: minerId,
                job: miner.getJob(),
                status: 'OK'
            });
            break;
        case 'getjob':
            if (!miner) {
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            miner.sendNewJob();
            break;
        case 'submit':
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
                if (job.submissions.indexOf(params.nonce) !== -1) {
                    console.warn(threadName + 'Duplicate share: ' + JSON.stringify(params) + ' from ' + miner.logString);
                    miner.checkBan(false);
                    sendReply('Duplicate share');
                    global.database.storeInvalidShare(miner.invalidShareProto);
                    return;
                }
                job.submissions.push(params.nonce);
            } else {
                if (!Number.isInteger(params.poolNonce) || !Number.isInteger(params.workerNonce)) {
                    console.warn(threadName + 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + miner.logString);
                    miner.checkBan(false);
                    sendReply('Duplicate share');
                    global.database.storeInvalidShare(miner.invalidShareProto);
                    return;
                }
                let nonce_test = `${params.nonce}_${params.poolNonce}_${params.workerNonce}`;
                if (job.submissions.indexOf(nonce_test) !== -1) {
                    console.warn(threadName + 'Duplicate share: ' + JSON.stringify(params) + ' from ' + miner.logString);
                    miner.checkBan(false);
                    sendReply('Duplicate share');
                    global.database.storeInvalidShare(miner.invalidShareProto);
                    return;
                }
                job.submissions.push(nonce_test);
            }

            let blockTemplate = activeBlockTemplate.height === job.height ? activeBlockTemplate : pastBlockTemplates.toarray().filter(function (t) {
                return t.height === job.height;
            })[0];

            if (!blockTemplate) {
                console.warn(threadName + 'Block expired, Height: ' + job.height + ' from ' + miner.logString);
                if (miner.incremented === false) {
                    miner.newDiff = miner.difficulty + 1;
                    miner.incremented = true;
                } else {
                    miner.newDiff = miner.difficulty - 1;
                    miner.incremented = false;
                }
                miner.sendNewJob();
                sendReply('Block expired');
                global.database.storeInvalidShare(miner.invalidShareProto);
                return;
            }

            let shareAccepted = processShare(miner, job, blockTemplate, params);
            miner.checkBan(shareAccepted);

            if (global.config.pool.trustedMiners) {
                if (shareAccepted) {
                    miner.trust.probability -= global.config.pool.trustChange;
                    if (miner.trust.probability < (global.config.pool.trustMin)) {
                        miner.trust.probability = global.config.pool.trustMin;
                    }
                    miner.trust.penalty--;
                    miner.trust.threshold--;
                }
                else {
                    console.log(threadName + "Share trust broken by " + miner.logString);
                    global.database.storeInvalidShare(miner.invalidShareProto);
                    miner.trust.probability = 256;
                    miner.trust.penalty = global.config.pool.trustPenalty;
                    miner.trust.threshold = global.config.pool.trustThreshold;
                }
            }

            if (!shareAccepted) {
                sendReply('Low difficulty share');
                return;
            }

            let now = Date.now() / 1000 || 0;
            miner.shareTimeBuffer.enq(now - miner.lastShareTime);
            miner.lastShareTime = now;

            sendReply(null, {status: 'OK'});
            break;
        case 'keepalived':
            if (!miner) {
                sendReply('Unauthenticated');
                return;
            }
            sendReply(null, {
                status: 'KEEPALIVED'
            });
            break;
    }
}

if (fs.existsSync("block_template_is_stuck")) {
   console.error("Stuck block template was detected on previous run. Please fix monerod and remove block_template_is_stuck file after that. Exiting...");
   process.exit();
}

if (cluster.isMaster) {
    let numWorkers = require('os').cpus().length;
    global.config.ports.forEach(function (portData) {
        minerCount[portData.port] = 0;
    });
    registerPool();
    setInterval(function () {
        global.mysql.query("UPDATE pools SET last_checkin = ?, active = ? WHERE id = ?", [global.support.formatDate(Date.now()), true, global.config.pool_id]);
        global.mysql.query("UPDATE pools SET blockIDTime = now(), blockID = ? where id = ?", [activeBlockTemplate.height, global.config.pool_id]);
        global.config.ports.forEach(function (portData) {
            global.mysql.query("UPDATE ports SET lastSeen = now(), miners = ? WHERE pool_id = ? AND network_port = ?", [minerCount[portData.port], global.config.pool_id, portData.port]);
        });
    }, 10000);
    console.log('Master cluster setting up ' + numWorkers + ' workers...');

    for (let i = 0; i < numWorkers; i++) {
        let worker = cluster.fork();
        worker.on('message', messageHandler);
        workerList.push(worker);
    }

    cluster.on('online', function (worker) {
        console.log('Worker ' + worker.process.pid + ' is online');
    });

    cluster.on('exit', function (worker, code, signal) {
        console.log('Worker ' + worker.process.pid + ' died with code: ' + code + ', and signal: ' + signal);
        console.log('Starting a new worker');
        worker = cluster.fork();
        worker.on('message', messageHandler);
        workerList.push(worker);
    });
    templateUpdate();
    setTimeout(templateUpdate, 100, true);
    global.support.sendEmail(global.config.general.adminEmail, "Pool server " + global.config.hostname + " online", "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " is online");
} else {
    setInterval(checkAliveMiners, 30000);
    setInterval(retargetMiners, global.config.pool.retargetTime * 1000);
    templateUpdate();
    setInterval(function () {
        bannedIPs = [];
        templateUpdate();
    }, 60000);

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
                console.log("Adding " + trust.toString() + " trust for " + wallet + " wallet");
                walletTrust[wallet] = trust;
                walletLastSeeTime[wallet] = time;
            }
        });
    }

    // dump wallet trust to file
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
       let fn = "wallet_trust_" + cluster.worker.id.toString();
       fs.writeFile(fn, str, function(err) { if (err) console.error("Error saving " + fn + " file"); });
    }, 10*60*1000);

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
            handleMinerData(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, pushMessage);
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

                            console.warn(threadName + "Malformed message from " + socket.remoteAddress + " Message: " + message);
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
            tls.createServer({
                key: fs.readFileSync('cert.key'),
                cert: fs.readFileSync('cert.pem')
            }, socketConn).listen(portData.port, global.config.bind_ip, function (error) {
                if (error) {
                    console.error(threadName + "Unable to start server on: " + portData.port + " Message: " + error);
                    return;
                }
                console.log(threadName + "Started server on port: " + portData.port);
            });
        } else {
            net.createServer(socketConn).listen(portData.port, global.config.bind_ip, function (error) {
                if (error) {
                    console.error(threadName + "Unable to start server on: " + portData.port + " Message: " + error);
                    return;
                }
                console.log(threadName + "Started server on port: " + portData.port);
            });
        }
    });
}
