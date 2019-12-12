"use strict";
const range = require("range");
const debug = require("debug")("blockManager");
const async = require("async");
const fs    = require('fs');

// This file is for managing the block databases within the SQL database.
// Primary Tasks:
// Sync the chain into the block_log database. - Scan on startup for missing data, starting from block 0
// Maintain a check for valid blocks in the system. (Only last number of blocks required for validation of payouts) - Perform every 2 minutes.  Scan on the main blocks table as well for sanity sake.
// Maintain the block_log database in order to ensure payments happen smoothly. - Scan every 1 second for a change in lastblockheader, if it changes, insert into the DB.

//let blockIDCache = [];
let paymentInProgress = false;
//let scanInProgress = false;
//let blockHexCache = {};
//let lastBlock = 0;
let balanceIDCache = {};
//let blockScannerTask;
//let blockQueue = async.queue(function (task, callback) {
//    global.coinFuncs.getBlockHeaderByID(task.blockID, (err, body) => {
//        if (err !== null) {
//            console.error("Can't get block with " + task.blockID + " height");
//            return callback();
//        }
//        if (body.hash in blockHexCache) {
//            return callback();
//        }
//        debug("Adding block to block_log, ID: " + task.blockID);
//        blockIDCache.push(task.blockID);
//        blockHexCache[body.hash] = null;
//        global.mysql.query("INSERT INTO block_log (id, orphan, hex, find_time, reward, difficulty, major_version, minor_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
//            [task.blockID, body.orphan_status, body.hash, global.support.formatDate(body.timestamp * 1000), body.reward, body.difficulty, body.major_version, body.minor_version]).then(function () {
//            return calculatePPSPayments(body, callback);
//        }).catch(function (err) {
//            debug("BlockHexCache Check: " + body.hash in blockHexCache);
//            debug("BlockIDCache Check: " + blockIDCache.hasOwnProperty(task.blockID));
//            debug("Hex: " + body.hash + " Height:" + task.blockID);
//            console.error("Tried to reprocess a block that'd already been processed");
//            console.error(JSON.stringify(err));
//            return callback();
//        });
//    });
//}, 16);

//blockQueue.drain = function () {
//    debug("blockQueue drained: unlocking remainder of blockManager functionality");
//    scanInProgress = false;
//    if (typeof(blockScannerTask) === 'undefined'){
//        blockScannerTask = setInterval(blockScanner, 1000);
//    }
//};

let createBlockBalanceQueue = async.queue(function (task, callback) {
    global.mysql.query("REPLACE INTO block_balance (hex, payment_address, payment_id, amount) VALUES (?, ?, ?, ?)", [task.hex, task.payment_address, task.payment_id, task.amount]).then(function (result) {
        if (!result.hasOwnProperty("affectedRows") || (result.affectedRows != 1 && result.affectedRows != 2)) {
           console.error(JSON.stringify(result));
           console.error("Can't do SQL block balance replace: REPLACE INTO block_balance (" + task.hex + ", " + task.payment_address + ", " + task.payment_id + ", " + task.amount + ");");
           return callback(false);
        }
        return callback(true);
    }).catch(function (err) {
        console.error(err);
        console.error("Can't do SQL block balance replace: REPLACE INTO block_balance (" + task.hex + ", " + task.payment_address + ", " + task.payment_id + ", " + task.amount + ");");
        return callback(false);
    });
}, 1);

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
        const pool_type       = task.pool_type;
        const bitcoin         = task.bitcoin;
        const amount          = task.amount;
        const payment_address = task.payment_address;
        let   payment_id      = null;
        if (typeof(task.payment_id) !== 'undefined' && task.payment_id !== null && task.payment_id.length > 10) payment_id = task.payment_id;
        task.payment_id = payment_id;
        debug("Processing balance increment task: " + JSON.stringify(task));
        async.waterfall([
                function (intCallback) {
                    let cacheKey = payment_address + pool_type + bitcoin + payment_id;
                    if (cacheKey in balanceIDCache) {
                        return intCallback(null, balanceIDCache[cacheKey]);
                    } else {
                        createBalanceQueue.push(task, function () {});
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
                    }).catch(function (err) {
                        console.error(err);
                        console.error("Can't do SQL balance update: UPDATE balance SET amount = amount+" + amount + " WHERE id = " + balance_id + ";")
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

let is_full_stop = false;

function full_stop(err) {
    is_full_stop = true;
    console.error("Issue making balance increases: " + JSON.stringify(err));
    console.error("Will not make more balance increases until it is resolved!");
    //toAddress, subject, body
    global.support.sendEmail(global.config.general.adminEmail, "blockManager unable to make balance increase",
      "Hello,\r\nThe blockManager has hit an issue making a balance increase: " + JSON.stringify(err) +
      ".  Please investigate and restart blockManager as appropriate");
}

let block_unlock_callback = null;
let prev_balance_sum      = null;

balanceQueue.drain = function () {
    if (!paymentInProgress) {
        debug("balanceQueue.drain: paymentInProgress is false");
        return;
    }
    if (block_unlock_callback === null) {
        debug("balanceQueue.drain: block_unlock_callback is not defined");
        return;
    }
    if (prev_balance_sum === null) {
        debug("balanceQueue.drain: prev_balance_sum is not defined");
        return;
    }
    console.log("balanceQueue drained: performing block unlocking");
    global.mysql.query("SELECT SUM(amount) as amt FROM balance").then(function (rows) {
        if (typeof(rows[0]) === 'undefined' || typeof(rows[0].amt) === 'undefined') {
            full_stop("SELECT SUM(amount) as amt FROM balance query returned undefined result");
            block_unlock_callback = null;
            prev_balance_sum = null;
            paymentInProgress = false;
            return;
	}
	let balance_sum = rows[0].amt;
        if (balance_sum !== prev_balance_sum) {
            console.log("Total balance changed from " + global.support.coinToDecimal(prev_balance_sum) + " to " + global.support.coinToDecimal(balance_sum));
            block_unlock_callback();
        } else {
            full_stop("Total balance not changed from " + prev_balance_sum + " to " + balance_sum);
        }
        block_unlock_callback = null;
        prev_balance_sum = null;
        paymentInProgress = false;
    });
};

function calculatePPSPayments(blockHeader, callback) {
    if (global.config.pps.enable === false) return callback();
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
    console.log("PPS payout cycle complete on block: " + blockHeader.height + " Block Value: " + global.support.coinToDecimal(blockHeader.reward) + " Block Payouts: " + global.support.coinToDecimal(totalPayments) + " Payout Percentage: " + (totalPayments / blockHeader.reward) * 100 + "%");
    return callback();
}

function preCalculatePPLNSPayments(block_hex, block_height, block_difficulty, done_callback) {
    const rewardTotal = 1.0;
    console.log("Performing PPLNS reward pre-calculations of block " + block_hex + " on (anchor) height " + block_height);
    const blockDiff   = block_difficulty;
    const windowPPLNS = blockDiff * global.config.pplns.shareMulti;

    let blockCheckHeight = block_height;
    let totalPaid        = 0;
    let totalShares      = 0;
    let paymentData      = {};

    paymentData[global.config.payout.feeAddress] = {
        pool_type:       'fees',
        payment_address: global.config.payout.feeAddress,
        payment_id:      null,
        bitcoin:         0,
        amount:          0
    };
    paymentData[global.coinFuncs.coinDevAddress] = {
        pool_type:       'fees',
        payment_address: global.coinFuncs.coinDevAddress,
        payment_id:      null,
        bitcoin:         0,
        amount:          0
    };
    paymentData[global.coinFuncs.poolDevAddress] = {
        pool_type:       'fees',
        payment_address: global.coinFuncs.poolDevAddress,
        payment_id:      null,
        bitcoin:         0,
        amount:          0
    };

    function addPayment(keyAdd, valueAdd) {
        if (valueAdd === 0) return;
        if (totalPaid >= rewardTotal) return;
        totalShares += valueAdd;
        paymentData[keyAdd].amount += valueAdd;
        const totalPaid2 = totalShares / windowPPLNS * rewardTotal;
        if (totalPaid2 > rewardTotal) { // totalPaid can not overflow rewardTotal now
            //console.log("Value totalPaid " + totalPaid  + " reached max " + rewardTotal);
            const extra = (totalPaid2 - rewardTotal) / rewardTotal * windowPPLNS;
            //console.log("Rewarded " + (valueAdd - extra)  + " instead of " + valueAdd  + " hashes for " + keyAdd);
            paymentData[keyAdd].amount -= extra;
            totalPaid = rewardTotal;
        } else {
            totalPaid = totalPaid2;
        }
    };

    let portShares = {};
    let firstShareTime;
    let lastShareTime;
    let shares4dump = [];

    shares4dump.push("#last_8_chars_ofxmr_address\ttimestamp\traw_share_diff\tshare_count\tshare_coin\txmr_share_diff\txmr_share_diff_payed");

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
                if (shareData.poolType === global.protos.POOLTYPE.PPLNS) {
                    const userIdentifier = shareData.paymentID ? shareData.paymentAddress + "." + shareData.paymentID : shareData.paymentAddress;
                    if (!(userIdentifier in paymentData)) {
                        paymentData[userIdentifier] = {
                            pool_type:      'pplns',
                            payment_address: shareData.paymentAddress,
                            payment_id:      shareData.paymentID,
                            bitcoin:         shareData.bitcoin,
                            amount:          0
                        };
                    }

                    if (!firstShareTime) firstShareTime = shareData.timestamp;
                    if (totalPaid < rewardTotal) lastShareTime = shareData.timestamp;

                    const amountToPay     = shareData.shares2;
                    const feesToPay       = amountToPay * (global.config.payout.pplnsFee / 100) +
                                          (shareData.bitcoin === true ? amountToPay * (global.config.payout.btcFee / 100) : 0);
                    const devDonation     = feesToPay * (global.config.payout.devDonation     / 100);
                    const poolDevDonation = feesToPay * (global.config.payout.poolDevDonation / 100);
                    const amountToPay2    = amountToPay - feesToPay;

		    shares4dump.push(userIdentifier.slice(-8) + "\t" + shareData.timestamp + "\t" + shareData.shares + "\t" + shareData.share_num + "\t" +
                                     global.coinFuncs.PORT2COIN_FULL(shareData.port) + "\t" + amountToPay + "\t" + amountToPay2);

                    addPayment(userIdentifier, amountToPay2);
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

        const fn = "block_share_dumps/" + block_hex + ".cvs";
        fs.writeFile(fn, shares4dump.join("\n"), function(err) { if (err) console.error("Error saving " + fn + " file"); });

        let sumAllPorts = 0;
        for (let port in portShares) sumAllPorts += portShares[port];
        let pplns_port_shares = {};
        for (let port in portShares) {
           const port_share = portShares[port] / sumAllPorts;
           pplns_port_shares[port] = port_share;
           //console.log("Port " + port + ": " + (100.0 * port_share).toFixed(2) + "%");
        }
        global.database.setCache('pplns_port_shares', pplns_port_shares);
        global.database.setCache('pplns_window_time', (firstShareTime - lastShareTime) / 1000);

        let totalPayments = 0;
        Object.keys(paymentData).forEach(function (key) {
            totalPayments += paymentData[key].amount;
        });

        if (totalPayments == 0) {
            console.warn("PPLNS payout cycle for " + block_hex + " block does not have any shares so will be redone using top height");
            global.support.sendEmail(global.config.general.adminEmail,
                "FYI: No shares to pay block, so it was corrected by using the top height",
                "PPLNS payout cycle for " + block_hex + " block does not have any shares so will be redone using top height"
            );
            global.coinFuncs.getLastBlockHeader(function(err, body){
                if (err !== null) {
                    console.error("Last block header request failed!");
                    return done_callback(false);
                }
                const topBlockHeight = body.height;
                return preCalculatePPLNSPayments(block_hex, topBlockHeight, block_difficulty, done_callback);
            });
            return;
        }

        const default_window     = blockDiff*global.config.pplns.shareMulti;
        const is_need_correction = Math.abs(totalPayments/default_window - 1) > 0.0001;
        const pay_window         = is_need_correction ? totalPayments : default_window;

        let add_count = 0;
        let is_ok = true;
        Object.keys(paymentData).forEach(function (key) {
            if (paymentData[key].amount) {
                paymentData[key].hex    = block_hex;
                paymentData[key].amount = paymentData[key].amount / pay_window;
                ++ add_count;
                createBlockBalanceQueue.push(paymentData[key], function (status) {
                    if (status === false) is_ok = false;
                    if (--add_count == 0) done_callback(is_ok);
                });
            }
        });

        console.log("PPLNS payout cycle complete on block: " + block_height + " Payout Percentage: " + (totalPayments / pay_window) * 100 + "% (precisely " + totalPayments + " / " + pay_window + ")");
        if (is_need_correction) {
            console.warn("(This PPLNS payout cycle complete on block was corrected: " + block_height + " Payout Percentage: " + (totalPayments / default_window) * 100 + "% (precisely " + totalPayments + " / " + default_window + "))");
            global.support.sendEmail(global.config.general.adminEmail,
                "Warning: Not enought shares to pay block correctly, so it was corrected by upscaling miner rewards!",
                "PPLNS payout cycle complete on block: " + block_height + " Payout Percentage: " + (totalPayments / pay_window) * 100 + "% (precisely " + totalPayments + " / " + pay_window + ")\n" +
                "(This PPLNS payout cycle complete on block was corrected: " + block_height + " Payout Percentage: " + (totalPayments / default_window) * 100 + "% (precisely " + totalPayments + " / " + default_window + "))"
            );
        }
    });
}

function doPPLNSPayments(block_hex, block_reward, unlock_callback) {
    console.log("Performing PPLNS payout of block " + block_hex + " with value " + global.support.coinToDecimal(block_reward));
    global.mysql.query("SELECT SUM(amount) as amt FROM balance").then(function (rows) {
        if (typeof(rows[0]) === 'undefined' || typeof(rows[0].amt) === 'undefined') {
            console.error("SELECT SUM(amount) as amt FROM balance query returned undefined result");
            return;
        }
        prev_balance_sum = rows[0].amt;

        global.mysql.query("SELECT payment_address, payment_id, amount FROM block_balance WHERE hex = ?", [block_hex]).then(function (rows) {
            if (rows.length) {
                block_unlock_callback = unlock_callback;
                rows.forEach(function (row) {
                    row.amount = Math.floor(row.amount * block_reward);
                    row.pool_type = "pplns";
                    row.bitcoin   = 0;
                    balanceQueue.push(row, function () {});
                });
            } else {
                console.error("Block " + block_hex + " has no payments in SQL");
            }
        });
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

let payReadyBlockHashCalc = {};

function blockUnlocker() {
    if (is_full_stop) {
        debug("Dropping all block unlocks");
        setTimeout(blockUnlocker, 2*60*1000);
        return;
    }
//    if (scanInProgress) {
//        debug("Skipping block unlocker run as there's a scan in progress");
//        return;
//    }
    if (paymentInProgress) {
        console.error("Skipping block unlocker run as there's a payment in progress");
        setTimeout(blockUnlocker, 2*60*1000);
        return;
    }
    console.log("Running block unlocker");
    let blockList = global.database.getValidLockedBlocks();
    global.coinFuncs.getLastBlockHeader(function(err, body){
        if (err !== null) {
            console.error("Last block header request failed!");
            return;
        }
        const topBlockHeight = body.height;
        async.eachSeries(blockList, function(block, next) {
            global.coinFuncs.getBlockHeaderByID(block.height, (err, body) => {
                if (err !== null) {
                    console.error("Can't get block with " + block.height + " height");
                    return next();
                }
                if (topBlockHeight - block.height <= 5) return next();
                const is_pplns_block = block.poolType == global.protos.POOLTYPE.PPLNS;
                if (body.hash !== block.hash) {
                    global.database.invalidateBlock(block.height);
                    //global.mysql.query("UPDATE block_log SET orphan = true WHERE hex = ?", [block.hash]);
                    //blockIDCache.splice(blockIDCache.indexOf(block.height));
                    console.log("Invalidating block " + block.height + " due to being an orphan block");
                    return next();
                } else if (is_pplns_block && !(block.hash in payReadyBlockHashCalc) && block.pay_ready !== true) {
                    payReadyBlockHashCalc[block.hash] = 1;
                    preCalculatePPLNSPayments(block.hash, block.height, block.difficulty, function(status) {
                        if (status) {
                            console.log("Completed PPLNS reward pre-calculations of block " + block.hash + " on height " + block.height);
                            global.database.payReadyBlock(block.hash);
                        }
                        return next();
                    });
                } else if (topBlockHeight - block.height > global.config.payout.blocksRequired && (!is_pplns_block || block.pay_ready === true)) {
                    blockPayments(block, function() { return next(); } );
                } else {
                    return next();
                }
            });
        }, function() {
            setTimeout(blockUnlocker, 2*60*1000);
        });
    });
}

function altblockUnlocker() {
    if (is_full_stop) {
        debug("Dropping all altblock unlocks");
        setTimeout(altblockUnlocker, 2*60*1000);
        return;
    }
//    if (scanInProgress) {
//        debug("Skipping altblock unlocker run as there's a scan in progress");
//        setTimeout(altblockUnlocker, 2*60*1000);
//        return;
//    }
    if (paymentInProgress) {
        console.error("Skipping altblock unlocker run as there's a payment in progress");
        setTimeout(altblockUnlocker, 2*60*1000);
        return;
    }
    let blockList = global.database.getValidLockedAltBlocks();
    console.log("Running altblock unlocker for " + blockList.length + " blocks");
    let blockHeightWait = {};
    global.coinFuncs.getLastBlockHeader(function(err, body){
        if (err !== null) {
            console.error("Last block header request failed!");
            setTimeout(altblockUnlocker, 2*60*1000);
            return;
        }
        const topBlockHeight = body.height;
        async.eachSeries(blockList, function(block, next) {
            if (topBlockHeight - block.anchor_height <= 5) return next();
            const is_pplns_block = block.poolType == global.protos.POOLTYPE.PPLNS;
            global.coinFuncs.getPortBlockHeaderByID(block.port, block.height, (err, body) => {
                const is_valid_request = (err === null);
                if (!is_valid_request) {
                    console.error("Can't get altblock of " + block.port + " port with  " + block.height + " height");
                }
                if (is_valid_request && body.hash !== block.hash) {
                    global.database.invalidateAltBlock(block.id);
                    console.log("Invalidating altblock from " + block.port + " port for " + block.height + " due to being an orphan block");
                    return next();
                } else if (is_pplns_block && !(block.hash in payReadyBlockHashCalc) && block.pay_ready !== true) {
                    global.coinFuncs.getBlockHeaderByID(block.anchor_height, function (anchor_err, anchor_header) {
                        if (anchor_err === null){
                            payReadyBlockHashCalc[block.hash] = 1;
                            preCalculatePPLNSPayments(block.hash, block.anchor_height, anchor_header.difficulty, function(status) {
                                if (status) {
                                    console.log("Completed PPLNS reward pre-calculations on altblock " + block.hash + " on anchor height " + block.anchor_height);
                                    global.database.payReadyAltBlock(block.hash);
                                }
                                return next();
                            });
                        } else {
                            console.error("Can't get correct anchor block header by height " + block.anchor_height.toString());
                            return next();
                        }
                    });
                } else if (is_valid_request && (!is_pplns_block || block.pay_ready === true)) {
                    if (block.pay_value !== 0) {
                        altblockPayments(block, function() { return next(); } );
                    } else {
                        if (!(block.port in blockHeightWait)) blockHeightWait[block.port] = [];
                        blockHeightWait[block.port].push(block.height);
                        return next();
                    }
                } else {
                    return next();
                }
            });
        }, function() {
            for (let port in blockHeightWait) {
                console.log("Waiting for altblock with " + port + " port and " + blockHeightWait[port].join(", ") + " height(s) pay value");
            }
            setTimeout(altblockUnlocker, 2*60*1000);
        });
    });
}

function blockPayments(block, cb) {
    switch (block.poolType) {
        case global.protos.POOLTYPE.PPS:
            // PPS is paid out per share find per block, so this is handled in the main block-find loop.
            global.database.unlockBlock(block.hash);
            return cb();

        case global.protos.POOLTYPE.PPLNS:
            global.coinFuncs.getBlockHeaderByHash(block.hash, function (err, header) {
                if (err === null && block.height === header.height && block.value === header.reward && block.difficulty === header.difficulty){
                    if (paymentInProgress) {
                        console.error("Skipping payment as there's a payment in progress");
                        return cb();
                    }
                    paymentInProgress = true;
                    doPPLNSPayments(block.hash, block.value, function() {
                        console.log("Unlocking main block on " + block.height + " height with " + block.hash.toString('hex') + " hash");
                        global.database.unlockBlock(block.hash);
                        return cb();
                    });
                } else {
                    console.error("Can't get correct block header by hash " + block.hash.toString('hex'));
                    global.support.sendEmail(global.config.general.adminEmail, "blockManager unable to make blockPayments",
                    "Hello,\r\nThe blockManager has hit an issue making blockPayments with block " + block.hash.toString('hex'));
                    return cb();
                }
            });
            break;
        case global.protos.POOLTYPE.SOLO:
            global.coinFuncs.getBlockHeaderByHash(block.hash, function (err, header) {
                if (err === null){
                    calculateSoloPayments(header);
                    global.database.unlockBlock(block.hash);
                }
                return cb();
            });
            break;
        default:
            console.error("Unknown payment type. FREAKOUT");
            return cb();
    }
}

function altblockPayments(block, cb) {
    if (paymentInProgress) {
        console.error("Skipping payment as there's a payment in progress");
        return cb();
    }
    switch (block.poolType) {
        case global.protos.POOLTYPE.PPLNS:
            global.coinFuncs.getPortBlockHeaderByHash(block.port, block.hash, function (err, header) {
                if (err === null && block.height === header.height && block.value >= header.reward /*&& block.difficulty === header.difficulty*/){
                    global.coinFuncs.getBlockHeaderByID(block.anchor_height, function (anchor_err, anchor_header) {
                        if (anchor_err === null){
                            if (paymentInProgress) {
                                console.error("Skipping payment as there's a payment in progress");
                                return cb();
                            }
                            paymentInProgress = true;
                            doPPLNSPayments(block.hash, block.pay_value, function() {
                                console.log("Unlocking " + block.port + " port block on " + block.height + " height with " + block.hash.toString('hex') + " hash");
                                global.database.unlockAltBlock(block.hash);
                                return cb();
                            });
                        } else {
                            console.error("Can't get correct anchor block header by height " + block.anchor_height.toString());
                            return cb();
                        }
                    });
                } else {
                    console.error("Can't get correct altblock header of " + block.port.toString() + " port by hash " + block.hash.toString('hex'));
                    return cb();
                }
            });
            break;
        default:
            console.error("Unknown payment type. FREAKOUT");
            return cb();
    }
}

//function blockScanner() {
//    let inc_check = 0;
//    if (scanInProgress) {
//        debug("Skipping scan as there's one in progress.");
//        return;
//    }
//    scanInProgress = true;
//    global.coinFuncs.getLastBlockHeader(function (err, blockHeader) {
//        if (err === null){
//            if (lastBlock === blockHeader.height) {
//                //debug("No new work to be performed, block header matches last block");
//                scanInProgress = false;
//                return;
//            }
//            debug("Parsing data for new blocks");
//            lastBlock = blockHeader.height;
//            range.range(0, (blockHeader.height - Math.floor(global.config.payout.blocksRequired/2))).forEach(function (blockID) {
//                if (!blockIDCache.hasOwnProperty(blockID)) {
//                    ++ inc_check;
//                    blockQueue.push({blockID: blockID}, function (err) {
//                        debug("Completed block scan on " + blockID);
//                        if (err) {
//                            console.error("Error processing " + blockID);
//                        }
//                    });
//                }
//            });
//            if (inc_check === 0) {
//                debug("No new work to be performed, initial scan complete");
//                scanInProgress = false;
//                blockScannerTask = setInterval(blockScanner, 1000);
//            }
//        } else {
//            console.error(`Upstream error from the block daemon.  Resetting scanner due to: ${JSON.stringify(blockHeader)}`);
//            scanInProgress = false;
//            blockScannerTask = setInterval(blockScanner, 1000);
//        }
//    });
//}

//function initial_sync() {
//    console.log("Performing boot-sync");
//    global.mysql.query("SELECT id, hex FROM block_log WHERE orphan = 0").then(function (rows) {
//        let intCount = 0;
//        rows.forEach(function (row) {
//            ++ intCount;
//            blockIDCache.push(row.id);
//            blockHexCache[row.hex] = null;
//        });
//    }).then(function () {
//        // Enable block scanning for 1 seconds to update the block log.
//        blockScanner();
//        // Scan every 120 seconds for invalidated blocks
//        setInterval(blockUnlocker, 2*60*1000);
//        blockUnlocker();
//        altblockUnlocker();
//        debug("Blocks loaded from SQL: " + blockIDCache.length);
//        console.log("Boot-sync from SQL complete: pending completion of queued jobs to get back to work.");
//    });
//}

//initial_sync();

blockUnlocker();
altblockUnlocker();