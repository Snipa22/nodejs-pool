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
let scanInProgress = false;
let blockHexCache = {};
let lastBlock = 0;
let balanceIDCache = {};
let blockScannerTask;
let blockQueue = async.queue(function (task, callback) {
    global.support.rpcDaemon('getblockheaderbyheight', {"height": task.blockID}, function (body) {
        let blockData = body.result.block_header;
        if (blockData.hash in blockHexCache) {
            return callback();
        }
        debug("Adding block to block_log, ID: " + task.blockID);
        blockIDCache.push(task.blockID);
        blockHexCache[body.result.block_header.hash] = null;
        global.mysql.query("INSERT INTO block_log (id, orphan, hex, find_time, reward, difficulty, major_version, minor_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [task.blockID, blockData.orphan_status, blockData.hash, global.support.formatDate(blockData.timestamp * 1000), blockData.reward, blockData.difficulty, blockData.major_version, blockData.minor_version]).then(function () {
            return calculatePPSPayments(blockData, callback);
        }).catch(function (err) {
            debug("BlockHexCache Check: " + blockData.hash in blockHexCache);
            debug("BlockIDCache Check: " + blockIDCache.hasOwnProperty(task.blockID));
            debug("Hex: " + blockData.hash + " Height:" + task.blockID);
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
                    global.mysql.query("UPDATE balance SET amount = amount+? WHERE id = ?", [amount, balance_id]).then(function () {
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
    console.log("Performing PPS payout on block: " + blockHeader.height + " Block Value: " + global.support.coinToDecimal(blockHeader.reward));
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
    Object.keys(paymentData).forEach(function (key) {
        balanceQueue.push(paymentData[key], function () {
        });
        totalPayments += paymentData[key].amount;
    });
    console.log("PPS payout cycle complete on block: " + blockHeader.height + " Block Value: " + global.support.coinToDecimal(blockHeader.reward) + " Block Payouts: " + global.support.coinToDecimal(totalPayments) + " Payout Percentage: " + (totalPayments / blockHeader.reward) * 100 + "%");
    return callback();
}

function calculatePPLNSPayments(blockHeader) {
    console.log("Performing PPLNS payout on block: " + blockHeader.height + " Block Value: " + global.support.coinToDecimal(blockHeader.reward));
    let rewardTotal = blockHeader.reward;
    let blockCheckHeight = blockHeader.height;
    let totalPaid = 0;
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
                let blockDiff = blockHeader.difficulty;
                let rewardTotal = blockHeader.reward;
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
                    let amountToPay = Math.floor((shareData.shares / (blockDiff*global.config.pplns.shareMulti)) * rewardTotal);
                    if (totalPaid + amountToPay > rewardTotal) {
                        amountToPay = rewardTotal - totalPaid;
                    }
                    totalPaid += amountToPay;
                    let feesToPay = Math.floor(amountToPay * (global.config.payout.pplnsFee / 100));
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
        let totalPayments = 0;
        Object.keys(paymentData).forEach(function (key) {
            balanceQueue.push(paymentData[key], function () {
            });
            totalPayments += paymentData[key].amount;
        });
        console.log("PPLNS payout cycle complete on block: " + blockHeader.height + " Block Value: " + global.support.coinToDecimal(blockHeader.reward) + " Block Payouts: " + global.support.coinToDecimal(totalPayments) + " Payout Percentage: " + (totalPayments / blockHeader.reward) * 100 + "%");
    });
}

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
    debug("Running block unlocker");
    let blockList = global.database.getValidLockedBlocks();
    global.support.rpcDaemon('getlastblockheader', [], function (body) {
        let blockHeight = body.result.block_header.height;
        blockList.forEach(function (row) {
            global.support.rpcDaemon('getblockheaderbyheight', {"height": row.height}, function (body) {
                if (body.result.block_header.hash !== row.hash) {
                    global.database.invalidateBlock(row.height);
                    global.mysql.query("UPDATE block_log SET orphan = true WHERE hex = ?", [row.hash]);
                    blockIDCache.splice(blockIDCache.indexOf(body.result.block_header.height));
                    console.log("Invalidating block " + body.result.block_header.height + " due to being an orphan block");
                } else {
                    if (blockHeight - row.height > global.config.payout.blocksRequired) {
                        blockPayments(row);
                    }
                }
            });

        });
    });
}

function blockPayments(block) {
    switch (block.poolType) {
        case global.protos.POOLTYPE.PPS:
            // PPS is paid out per share find per block, so this is handled in the main block-find loop.
            break;
        case global.protos.POOLTYPE.PPLNS:
            global.coinFuncs.getBlockHeaderByHash(block.hash, function (header) {
                calculatePPLNSPayments(header);
            });
            break;
        case global.protos.POOLTYPE.SOLO:
            global.coinFuncs.getBlockHeaderByHash(block.hash, function (header) {
                calculateSoloPayments(header);
            });
            break;
        default:
            console.log("Unknown payment type.  FREAKOUT");
            break;
    }
    global.database.unlockBlock(block.hash);
}

function blockScanner() {
    let inc_check = 0;
    if (scanInProgress) {
        debug("Skipping scan as there's one in progress.");
        return;
    }
    scanInProgress = true;
    global.coinFuncs.getLastBlockHeader(function (blockHeader) {
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
        debug("Blocks loaded from SQL: " + blockIDCache.length);
        console.log("Boot-sync from SQL complete.  Pending completion of queued jobs to get back to work.");
    });
}

initial_sync();
