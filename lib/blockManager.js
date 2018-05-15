"use strict";
const range = require("range");
const debug = require("debug")("blockManager");
const async = require("async");

// This file is for managing the block databases within the SQL database.
// Primary Tasks:
// Sync the chain into the block_log database. - Scan on startup for missing data, starting from block 0
// Maintain a check for valid blocks in the system. (Only last number of blocks required for validation of payouts) - Perform every 2 minutes.  Scan on the main blocks table as well for sanity sake.
// Maintain the block_log database in order to ensure payments happen smoothly. - Scan every 1 second for a change in lastblockheader, if it changes, insert into the DB.

let blockIDCache = [];
let paymentInProgress = false;
let scanInProgress = false;
let blockHexCache = {};
let lastBlock = 0;
let balanceIDCache = {};
let blockScannerTask;
let blockQueue = async.queue(function (task, callback) {
    global.coinFuncs.getBlockHeaderByID(task.blockID, (err, body) => {
        if (err !== null) {
            console.error("Can't get block with " + task.blockID + " height");
            return;
        }
        if (body.hash in blockHexCache) {
            return callback();
        }
        debug("Adding block to block_log, ID: " + task.blockID);
        blockIDCache.push(task.blockID);
        blockHexCache[body.hash] = null;
        global.mysql.query("INSERT INTO block_log (id, orphan, hex, find_time, reward, difficulty, major_version, minor_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [task.blockID, body.orphan_status, body.hash, global.support.formatDate(body.timestamp * 1000), body.reward, body.difficulty, body.major_version, body.minor_version]).then(function () {
            return calculatePPSPayments(body, callback);
        }).catch(function (err) {
            debug("BlockHexCache Check: " + body.hash in blockHexCache);
            debug("BlockIDCache Check: " + blockIDCache.hasOwnProperty(task.blockID));
            debug("Hex: " + body.hash + " Height:" + task.blockID);
            console.error("Tried to reprocess a block that'd already been processed");
            console.error(JSON.stringify(err));
            return callback();
        });
    });
}, 16);

blockQueue.drain = function () {
    console.log("Scan complete, unlocking remainder of blockManager functionality.");
    scanInProgress = false;
    if (typeof(blockScannerTask) === 'undefined'){
        blockScannerTask = setInterval(blockScanner, 1000);
    }
};

let createBalanceQueue = async.queue(function (task, callback) {
    let pool_type = task.pool_type;
    let payment_address = task.payment_address;
    let payment_id = task.payment_id;
    let bitcoin = task.bitcoin;
    let query = "SELECT id FROM balance WHERE payment_address = ? AND payment_id is ? AND pool_type = ? AND bitcoin = ?";
    if (payment_id !== null) {
        query = "SELECT id FROM balance WHERE payment_address = ? AND payment_id = ? AND pool_type = ? AND bitcoin = ?";
    }
    let cacheKey = payment_address + pool_type + bitcoin + payment_id;
    debug("Processing a account add/check for:" + JSON.stringify(task));
    global.mysql.query(query, [payment_address, payment_id, pool_type, bitcoin]).then(function (rows) {
        if (rows.length === 0) {
            global.mysql.query("INSERT INTO balance (payment_address, payment_id, pool_type, bitcoin) VALUES (?, ?, ?, ?)", [payment_address, payment_id, pool_type, bitcoin]).then(function (result) {
                debug("Added to the SQL database: " + result.insertId);
                balanceIDCache[cacheKey] = result.insertId;
                return callback();
            });
        } else {
            debug("Found it in MySQL: " + rows[0].id);
            balanceIDCache[cacheKey] = rows[0].id;
            return callback();
        }
    });
}, 1);

let balanceQueue = async.queue(function (task, callback) {
        let pool_type = task.pool_type;
        let payment_address = task.payment_address;
        let payment_id = null;
        if (typeof(task.payment_id) !== 'undefined' && task.payment_id !== null && task.payment_id.length > 10){
            payment_id = task.payment_id;
        }
        task.payment_id = payment_id;
        let bitcoin = task.bitcoin;
        let amount = task.amount;
        debug("Processing balance increment task: " + JSON.stringify(task));
        async.waterfall([
                function (intCallback) {
                    let cacheKey = payment_address + pool_type + bitcoin + payment_id;
                    if (cacheKey in balanceIDCache) {
                        return intCallback(null, balanceIDCache[cacheKey]);
                    } else {
                        createBalanceQueue.push(task, function () {
                        });
                        async.until(function () {
                                return cacheKey in balanceIDCache;
                            }, function (intCallback) {
                                createBalanceQueue.push(task, function () {
                                    return intCallback(null, balanceIDCache[cacheKey]);
                                });
                            }, function () {
                                return intCallback(null, balanceIDCache[cacheKey]);
                            }
                        );
                    }
                },
                function (balance_id, intCallback) {
                    debug("Made it to the point that I can update the balance for: " + balance_id + " for the amount: " + amount);
                    global.mysql.query("UPDATE balance SET amount = amount+? WHERE id = ?", [amount, balance_id]).then(function (result) {
                        if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                           console.error("Can't do SQL balance update: UPDATE balance SET amount = amount+" + amount + " WHERE id = " + balance_id + ";")
                        }
                        return intCallback(null);
                    });
                }
            ],
            function () {
                return callback();
            }
        )
        ;
    }, 24
);

function calculatePPSPayments(blockHeader, callback) {
    if (global.config.pps.enable === true) {
        console.log("Performing PPS payout on block: " + blockHeader.height + " Block Value: " + global.support.coinToDecimal(blockHeader.reward));
    }
    let paymentData = {};
    paymentData[global.config.payout.feeAddress] = {
        pool_type: 'fees',
        payment_address: global.config.payout.feeAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0
    };
    paymentData[global.coinFuncs.coinDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.coinDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0
    };
    paymentData[global.coinFuncs.poolDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.poolDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0
    };
    let totalPayments = 0;
    if (global.config.pps.enable === true) {
        let txn = global.database.env.beginTxn({readOnly: true});
        let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
        for (let found = (cursor.goToRange(blockHeader.height) === blockHeader.height); found; found = cursor.goToNextDup()) {
            cursor.getCurrentBinary(function (key, data) {  // jshint ignore:line
                let shareData;
                try {
                    shareData = global.protos.Share.decode(data);
                } catch (e) {
                    console.error(e);
                    return;
                }
                let blockDiff = blockHeader.difficulty;
                let rewardTotal = blockHeader.reward;
                if (shareData.poolType === global.protos.POOLTYPE.PPS) {
                    let userIdentifier = shareData.paymentAddress;
                    if (shareData.paymentID) {
                        userIdentifier = userIdentifier + "." + shareData.paymentID;
                    }
                    if (!(userIdentifier in paymentData)) {
                        paymentData[userIdentifier] = {
                            pool_type: 'pps',
                            payment_address: shareData.paymentAddress,
                            payment_id: shareData.paymentID,
                            bitcoin: shareData.bitcoin,
                            amount: 0
                        };
                    }
                    let amountToPay = Math.floor((shareData.shares / blockDiff) * rewardTotal);
                    let feesToPay = Math.floor(amountToPay * (global.config.payout.ppsFee / 100));
                    if (shareData.bitcoin === true) {
                        feesToPay += Math.floor(amountToPay * (global.config.payout.btcFee / 100));
                    }
                    amountToPay -= feesToPay;
                    paymentData[userIdentifier].amount = paymentData[userIdentifier].amount + amountToPay;
                    let donations = 0;
                    if(global.config.payout.devDonation > 0){
                        let devDonation = (feesToPay * (global.config.payout.devDonation / 100));
                        donations += devDonation;
                        paymentData[global.coinFuncs.coinDevAddress].amount = paymentData[global.coinFuncs.coinDevAddress].amount + devDonation ;
                    }
                    if(global.config.payout.poolDevDonation > 0){
                        let poolDevDonation = (feesToPay * (global.config.payout.poolDevDonation / 100));
                        donations += poolDevDonation;
                        paymentData[global.coinFuncs.poolDevAddress].amount = paymentData[global.coinFuncs.poolDevAddress].amount + poolDevDonation;
                    }
                    paymentData[global.config.payout.feeAddress].amount = paymentData[global.config.payout.feeAddress].amount + feesToPay - donations;
                }
            });
        }
        cursor.close();
        txn.abort();
    }
    Object.keys(paymentData).forEach(function (key) {
        balanceQueue.push(paymentData[key], function () {
        });
        totalPayments += paymentData[key].amount;
    });
    if (global.config.pps.enable === true) {
        console.log("PPS payout cycle complete on block: " + blockHeader.height + " Block Value: " + global.support.coinToDecimal(blockHeader.reward) + " Block Payouts: " + global.support.coinToDecimal(totalPayments) + " Payout Percentage: " + (totalPayments / blockHeader.reward) * 100 + "%");
    }
    return callback();
}

function calculatePPLNSPayments(block_height, block_reward, block_difficulty, unlock_callback) {
    if (paymentInProgress) {
        debug("Skipping block payment run as there's a payment in progress");
        return;
    }
    paymentInProgress = true;
    console.log("Performing PPLNS payout on block: " + block_height + " Block Value: " + global.support.coinToDecimal(block_reward));
    let rewardTotal = block_reward;
    let blockDiff = block_difficulty;
    let windowPPLNS = blockDiff * global.config.pplns.shareMulti;
    let blockCheckHeight = block_height;
    let totalPaid = 0;
    let totalShares = 0;
    let paymentData = {};
    paymentData[global.config.payout.feeAddress] = {
        pool_type: 'fees',
        payment_address: global.config.payout.feeAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0
    };
    paymentData[global.coinFuncs.coinDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.coinDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0
    };
    paymentData[global.coinFuncs.poolDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.poolDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0
    };

    function addPayment(keyAdd, valueAdd) {
        if (valueAdd === 0) return;
        if (totalPaid >= rewardTotal) return;
        totalShares += valueAdd;
        paymentData[keyAdd].amount += valueAdd;
        let totalPaid2 = totalShares / windowPPLNS * rewardTotal;
        if (totalPaid2 + 1 < rewardTotal) { // totalPaid can not overflow rewardTotal now
            totalPaid = totalPaid2;
        } else { // we need recalculate totalPaid precisely now
            totalPaid = 0;
            Object.keys(paymentData).forEach(function (key) {
                totalPaid += Math.floor(paymentData[key].amount / windowPPLNS * rewardTotal);
            });
            console.log("Aproximate totalPaid " + totalPaid2 + " was reset to precise value " + totalPaid);
            if (totalPaid >= rewardTotal) {
                console.log("Precise value totalPaid " + totalPaid  + " reached max " + rewardTotal);
                let extra = (totalPaid - rewardTotal) / rewardTotal * windowPPLNS;
                console.log("Rewarded " + (valueAdd - extra)  + " instead of " + valueAdd  + " hashes for " + keyAdd);
                paymentData[keyAdd].amount -= extra;
                totalPaid = rewardTotal;
            }
        }
    };

    let portShares = {};

    async.doWhilst(function (callback) {
        let txn = global.database.env.beginTxn({readOnly: true});
        let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
        for (let found = (cursor.goToRange(blockCheckHeight) === blockCheckHeight); found; found = cursor.goToNextDup()) {
            cursor.getCurrentBinary(function (key, data) {  // jshint ignore:line
                let shareData;
                try {
                    shareData = global.protos.Share.decode(data);
                } catch (e) {
                    console.error(e);
                    return;
                }
                let blockDiff = block_difficulty;
                let rewardTotal = block_reward;
                if (shareData.poolType === global.protos.POOLTYPE.PPLNS) {
                    let userIdentifier = shareData.paymentAddress;
                    if (shareData.paymentID) {
                        userIdentifier = userIdentifier + "." + shareData.paymentID;
                    }
                    if (!(userIdentifier in paymentData)) {
                        paymentData[userIdentifier] = {
                            pool_type: 'pplns',
                            payment_address: shareData.paymentAddress,
                            payment_id: shareData.paymentID,
                            bitcoin: shareData.bitcoin,
                            amount: 0
                        };
                    }

                    let amountToPay     = shareData.shares;
                    let feesToPay       = amountToPay * (global.config.payout.pplnsFee / 100) +
                                          (shareData.bitcoin === true ? amountToPay * (global.config.payout.btcFee / 100) : 0);
                    let devDonation     = feesToPay * (global.config.payout.devDonation     / 100);
                    let poolDevDonation = feesToPay * (global.config.payout.poolDevDonation / 100);

                    addPayment(userIdentifier, amountToPay - feesToPay);
                    addPayment(global.config.payout.feeAddress, feesToPay - devDonation - poolDevDonation);
                    addPayment(global.coinFuncs.poolDevAddress, poolDevDonation);
                    addPayment(global.coinFuncs.coinDevAddress, devDonation);

                    if (typeof(shareData.port) !== 'undefined') {
                        if (shareData.port in portShares) {
                            portShares[shareData.port] += amountToPay;
                        } else {
                            portShares[shareData.port] = amountToPay;
                        }
                    }
                }
            });
        }
        cursor.close();
        txn.abort();
        setImmediate(callback, null, totalPaid);
    }, function (totalPayment) {
        blockCheckHeight = blockCheckHeight - 1;
        debug("Decrementing the block chain check height to:" + blockCheckHeight);
        if (totalPayment >= rewardTotal) {
            debug("Loop 1: Total Payment: " + totalPayment + " Amount Paid: " + rewardTotal + " Amount Total: " + totalPaid);
            return false;
        } else {
            debug("Loop 2: Total Payment: " + totalPayment + " Amount Paid: " + rewardTotal + " Amount Total: " + totalPaid);
            return blockCheckHeight !== 0;
        }
    }, function (err) {
        let sumAllPorts = 0;
        for (let port in portShares) sumAllPorts += portShares[port];
        for (let port in portShares) {
           console.log("Port " + port + ": " + (100.0 * portShares[port] / sumAllPorts).toFixed(2) + "%");
        }
        let totalPayments = 0;
        Object.keys(paymentData).forEach(function (key) {
            paymentData[key].amount = Math.floor((paymentData[key].amount / (blockDiff*global.config.pplns.shareMulti)) * rewardTotal);
            balanceQueue.push(paymentData[key], function () {});
            //console.log("[PAYMENT] " + key + ": " + global.support.coinToDecimal(paymentData[key].amount));
            totalPayments += paymentData[key].amount;
        });
        console.log("PPLNS payout cycle complete on block: " + block_height + " Block Value: " + global.support.coinToDecimal(block_reward) + " Block Payouts: " + global.support.coinToDecimal(totalPayments) + " Payout Percentage: " + (totalPayments / block_reward) * 100 + "% (precisely " + totalPayments + " / " + block_reward + ")");
        unlock_callback();
        paymentInProgress = false;
        if (totalPayments != block_reward) {
            global.support.sendEmail(global.config.general.adminEmail,
                "Block was not payed completely!",
                "PPLNS payout cycle complete on block: " + block_height + " Block Value: " + global.support.coinToDecimal(block_reward) + " Block Payouts: " + global.support.coinToDecimal(totalPayments) + " Payout Percentage: " + (totalPayments / block_reward) * 100 + "% (precisely " + totalPayments + " / " + block_reward + ")"
            );
        }
    });
};

function calculateSoloPayments(blockHeader) {
    console.log("Performing Solo payout on block: " + blockHeader.height + " Block Value: " + global.support.coinToDecimal(blockHeader.reward));
    let txn = global.database.env.beginTxn({readOnly: true});
    let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
    let paymentData = {};
    paymentData[global.config.payout.feeAddress] = {
        pool_type: 'fees',
        payment_address: global.config.payout.feeAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0
    };
    paymentData[global.coinFuncs.coinDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.coinDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0
    };
    paymentData[global.coinFuncs.poolDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.poolDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0
    };
    let totalPayments = 0;
    for (let found = (cursor.goToRange(blockHeader.height) === blockHeader.height); found; found = cursor.goToNextDup()) {
        cursor.getCurrentBinary(function (key, data) {  // jshint ignore:line
            let shareData;
            try {
                shareData = global.protos.Share.decode(data);
            } catch (e) {
                console.error(e);
                return;
            }
            let rewardTotal = blockHeader.reward;
            if (shareData.poolType === global.protos.POOLTYPE.SOLO && shareData.foundBlock === true) {
                let userIdentifier = shareData.paymentAddress;
                if (shareData.paymentID) {
                    userIdentifier = userIdentifier + "." + shareData.paymentID;
                }
                if (!(userIdentifier in paymentData)) {
                    paymentData[userIdentifier] = {
                        pool_type: 'solo',
                        payment_address: shareData.paymentAddress,
                        payment_id: shareData.paymentID,
                        bitcoin: shareData.bitcoin,
                        amount: 0
                    };
                }
                let feesToPay = Math.floor(rewardTotal * (global.config.payout.soloFee / 100));
                if (shareData.bitcoin === true) {
                    feesToPay += Math.floor(rewardTotal * (global.config.payout.btcFee / 100));
                }
                rewardTotal -= feesToPay;
                paymentData[userIdentifier].amount = rewardTotal;
                let donations = 0;
                if(global.config.payout.devDonation > 0){
                    let devDonation = (feesToPay * (global.config.payout.devDonation / 100));
                    donations += devDonation;
                    paymentData[global.coinFuncs.coinDevAddress].amount = paymentData[global.coinFuncs.coinDevAddress].amount + devDonation ;
                }
                if(global.config.payout.poolDevDonation > 0){
                    let poolDevDonation = (feesToPay * (global.config.payout.poolDevDonation / 100));
                    donations += poolDevDonation;
                    paymentData[global.coinFuncs.poolDevAddress].amount = paymentData[global.coinFuncs.poolDevAddress].amount + poolDevDonation;
                }
                paymentData[global.config.payout.feeAddress].amount = feesToPay - donations;
            }
        });
    }
    cursor.close();
    txn.abort();
    Object.keys(paymentData).forEach(function (key) {
        balanceQueue.push(paymentData[key], function () {
        });
        totalPayments += paymentData[key].amount;
    });
    console.log("Solo payout cycle complete on block: " + blockHeader.height + " Block Value: " + global.support.coinToDecimal(blockHeader.reward) + " Block Payouts: " + global.support.coinToDecimal(totalPayments) + " Payout Percentage: " + (totalPayments / blockHeader.reward) * 100 + "%");
}

function blockUnlocker() {
    if (scanInProgress) {
        debug("Skipping block unlocker run as there's a scan in progress");
        return;
    }
    if (paymentInProgress) {
        debug("Skipping block unlocker run as there's a payment in progress");
        return;
    }
    debug("Running block unlocker");
    let blockList = global.database.getValidLockedBlocks();
    global.coinFuncs.getLastBlockHeader(function(err, body){
        if (err !== null) {
            console.error("Last block header request failed!");
            return;
        }
        let topBlockHeight = body.height;
        blockList.forEach(function (block) {
            global.coinFuncs.getBlockHeaderByID(block.height, (err, body) => {
                if (err !== null) {
                    console.error("Can't get block with " + block.height + " height");
                    return;
                }
                if (body.hash !== block.hash) {
                    global.database.invalidateBlock(block.height);
                    global.mysql.query("UPDATE block_log SET orphan = true WHERE hex = ?", [block.hash]);
                    blockIDCache.splice(blockIDCache.indexOf(block.height));
                    console.log("Invalidating block " + block.height + " due to being an orphan block");
                } else {
                    if (topBlockHeight - block.height > global.config.payout.blocksRequired) {
                        blockPayments(block);
                    }
                }
            });

        });
    });
}

function altblockUnlocker() {
    if (scanInProgress) {
        debug("Skipping altblock unlocker run as there's a scan in progress");
        return;
    }
    if (paymentInProgress) {
        debug("Skipping altblock unlocker run as there's a payment in progress");
        return;
    }
    debug("Running altblock unlocker");
    let blockList = global.database.getValidLockedAltBlocks();
    blockList.forEach(function (block) {
        global.coinFuncs.getPortBlockHeaderByID(block.port, block.height, (err, body) => {
            if (err !== null) {
                console.error("Can't get altblock of " + block.port + " port with  " + block.height + " height");
                return;
            }
            if (body.hash !== block.hash) {
                global.database.invalidateAltBlock(block.id);
                console.log("Invalidating altblock from " + block.port + " port for " + block.height + " due to being an orphan block");
            } else {
                if (block.pay_value !== 0) {
                    altblockPayments(block);
                } else {
                    console.log("Waiting for altblock with " + block.port + " port and " + block.height + " height pay value");
                }
            }
        });

    });
}

function blockPayments(block) {
    switch (block.poolType) {
        case global.protos.POOLTYPE.PPS:
            // PPS is paid out per share find per block, so this is handled in the main block-find loop.
            global.database.unlockBlock(block.hash);
            break;
        case global.protos.POOLTYPE.PPLNS:
            global.coinFuncs.getBlockHeaderByHash(block.hash, function (err, header) {
                if (err === null && block.height === header.height && block.value === header.reward && block.difficulty === header.difficulty){
                    calculatePPLNSPayments(block.height, block.value, block.difficulty, function() {
                        console.log("Unlocking main block on " + block.height + " height with " + block.hash.toString('hex') + " hash");
                        global.database.unlockBlock(block.hash);
                    });
                } else {
                    console.error("Can't get correct block header by hash " + block.hash.toString('hex'));
                }
            });
            break;
        case global.protos.POOLTYPE.SOLO:
            global.coinFuncs.getBlockHeaderByHash(block.hash, function (err, header) {
                if (err === null){
                    calculateSoloPayments(header);
                    global.database.unlockBlock(block.hash);
                }
            });
            break;
        default:
            console.log("Unknown payment type. FREAKOUT");
            global.database.unlockBlock(block.hash);
            break;
    }
}

function altblockPayments(block) {
    switch (block.poolType) {
        case global.protos.POOLTYPE.PPLNS:
            global.coinFuncs.getPortBlockHeaderByHash(block.port, block.hash, function (err, header) {
                if (err === null && block.height === header.height && block.value === header.reward && block.difficulty === header.difficulty){
                    global.coinFuncs.getBlockHeaderByID(block.anchor_height, function (anchor_err, anchor_header) {
                        if (anchor_err === null){
                            calculatePPLNSPayments(block.anchor_height, block.pay_value, anchor_header.difficulty, function() {
                                console.log("Unlocking " + block.port + " port block on " + block.height + " height with " + block.hash.toString('hex') + " hash");
                                global.database.unlockAltBlock(block.hash);
                            });
                        } else {
                            console.error("Can't get correct block header by height " + block.anchor_height.toString());
                        }
                    });
                } else {
                    console.error("Can't get correct altblock header of " + block.port.toString() + " port by hash " + block.hash.toString('hex'));
                }
            });
            break;
        default:
            console.log("Unknown payment type. FREAKOUT");
            global.database.unlockAltBlock(block.hash);
            break;
    }
}

function blockScanner() {
    let inc_check = 0;
    if (scanInProgress) {
        debug("Skipping scan as there's one in progress.");
        return;
    }
    scanInProgress = true;
    global.coinFuncs.getLastBlockHeader(function (err, blockHeader) {
        if (err === null){
            if (lastBlock === blockHeader.height) {
                debug("No new work to be performed, block header matches last block");
                scanInProgress = false;
                return;
            }
            debug("Parsing data for new blocks");
            lastBlock = blockHeader.height;
            range.range(0, (blockHeader.height - Math.floor(global.config.payout.blocksRequired/2))).forEach(function (blockID) {
                if (!blockIDCache.hasOwnProperty(blockID)) {
                    inc_check += 1;
                    blockQueue.push({blockID: blockID}, function (err) {
                        debug("Completed block scan on " + blockID);
                        if (err) {
                            console.error("Error processing " + blockID);
                        }
                    });
                }
            });
            if (inc_check === 0) {
                debug("No new work to be performed, initial scan complete");
                scanInProgress = false;
                blockScannerTask = setInterval(blockScanner, 1000);
            }
        } else {
            console.error(`Upstream error from the block daemon.  Resetting scanner due to: ${JSON.stringify(blockHeader)}`);
            scanInProgress = false;
            blockScannerTask = setInterval(blockScanner, 1000);
        }
    });
}

function initial_sync() {
    console.log("Performing boot-sync");
    global.mysql.query("SELECT id, hex FROM block_log WHERE orphan = 0").then(function (rows) {
        let intCount = 0;
        rows.forEach(function (row) {
            intCount += 1;
            blockIDCache.push(row.id);
            blockHexCache[row.hex] = null;
        });
    }).then(function () {
        // Enable block scanning for 1 seconds to update the block log.
        blockScanner();
        // Scan every 120 seconds for invalidated blocks
        setInterval(blockUnlocker, 120000);
        blockUnlocker();
        setInterval(altblockUnlocker, 120000);
        altblockUnlocker();
        debug("Blocks loaded from SQL: " + blockIDCache.length);
        console.log("Boot-sync from SQL complete.  Pending completion of queued jobs to get back to work.");
    });
}

initial_sync();
