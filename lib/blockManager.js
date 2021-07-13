"use strict";
const range = require("range");
const debug = require("debug")("blockManager");
const async = require("async");
const fs    = require('fs');
const child_process = require('child_process');

// This file is for managing the block databases within the SQL database.
// Primary Tasks:
// Maintain a check for valid blocks in the system. (Only last number of blocks required for validation of payouts) - Perform every 2 minutes.  Scan on the main blocks table as well for sanity sake.
// Maintain the block_log database in order to ensure payments happen smoothly. - Scan every 1 second for a change in lastblockheader, if it changes, insert into the DB.

let paymentInProgress = false;
let balanceIDCache = {};

let createBlockBalanceQueue = async.queue(function (task, callback) {
    const sqlq = "REPLACE INTO block_balance (hex, payment_address, payment_id, amount) VALUES ?";
    let sqlp = [];
    task.hexes.forEach(function(block_hex) {
       sqlp.push([block_hex, task.payment_address, task.payment_id, task.amount]);
    });
    global.mysql.query(sqlq, [sqlp]).then(function (result) {
        if (!result.hasOwnProperty("affectedRows") || result.affectedRows < task.hexes.length) {
           console.error(JSON.stringify(result));
           console.error("Can't do SQL block balance replace: " + sqlq + " with " + JSON.stringify(sqlp));
           return callback(false);
        }
        return callback(true);
    }).catch(function (err) {
        console.error(err);
        console.error("Can't do SQL block balance replace: " + sqlq + " with " + JSON.stringify(sqlp));
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
                async.until(function (untilCB) {
                        return untilCB(null, cacheKey in balanceIDCache);
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
    });
}, 24);

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

balanceQueue.drain(function () {
    if (!paymentInProgress) {
        debug("balanceQueue.drain: paymentInProgress is false");
        return;
    }
    if (block_unlock_callback === null) {
        debug("balanceQueue.drain: block_unlock_callback is not defined");
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
            console.log("Total balance changed from " + global.support.coinToDecimal(prev_balance_sum) + " to " + global.support.coinToDecimal(balance_sum) + "\n");
            block_unlock_callback();
        } else {
            full_stop("Total balance not changed from " + prev_balance_sum + " to " + balance_sum);
        }
        block_unlock_callback = null;
        prev_balance_sum = null;
        paymentInProgress = false;
    });
});

function preCalculatePPLNSPayments(block_hexes, block_height, block_difficulty, is_store_dump, done_callback) {
    const rewardTotal = 1.0;
    console.log("Performing PPLNS reward pre-calculations of block " + block_hexes.join(', ') + " on (anchor) height " + block_height);
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

		    shares4dump.push(userIdentifier.slice(-16) + "\t" + shareData.timestamp.toString(16) + "\t" + shareData.raw_shares + "\t" + shareData.share_num + "\t" +
                                     global.coinFuncs.PORT2COIN_FULL(shareData.port) + "\t" + amountToPay + "\t" + (amountToPay === amountToPay2 ? "" : amountToPay2));

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
    }, function (totalPayment, whilstCB) {
        blockCheckHeight = blockCheckHeight - 1;
        debug("Decrementing the block chain check height to:" + blockCheckHeight);
        if (totalPayment >= rewardTotal) {
            debug("Loop 1: Total Payment: " + totalPayment + " Amount Paid: " + rewardTotal + " Amount Total: " + totalPaid);
            return whilstCB(null, false);
        } else {
            debug("Loop 2: Total Payment: " + totalPayment + " Amount Paid: " + rewardTotal + " Amount Total: " + totalPaid);
            return whilstCB(null, blockCheckHeight !== 0);
        }
    }, function (err) {

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

        let is_dump_done = false;
        let is_ok        = true;
        let is_pay_done  = false;

        if (totalPayments == 0) {
            console.warn("PPLNS payout cycle for " + block_hexes.join(', ') + " block does not have any shares so will be redone using top height");
            global.support.sendEmail(global.config.general.adminEmail,
                "FYI: No shares to pay block, so it was corrected by using the top height",
                "PPLNS payout cycle for " + block_hexes.join(', ') + " block does not have any shares so will be redone using top height"
            );
            global.coinFuncs.getLastBlockHeader(function(err, body){
                if (err !== null) {
                    console.error("Last block header request failed!");
                    return done_callback(false);
                }
                const topBlockHeight = body.height;
                return preCalculatePPLNSPayments(block_hexes, topBlockHeight, block_difficulty, is_store_dump, done_callback);
            });
            return;
        } else {
            if (is_store_dump && fs.existsSync("./block_share_dumps/process.sh")) {
                shares4dump.sort();
                shares4dump.unshift("#last_16_chars_of_xmr_address\ttimestamp\traw_share_diff\tshare_count\tshare_coin\txmr_share_diff\txmr_share_diff_paid");
                const fn = "block_share_dumps/" + block_hexes[0] + ".cvs";
                fs.writeFile(fn, shares4dump.join("\n"), function(err) {
                    if (err) {
                        console.error("Error saving " + fn + " file");
                        is_dump_done = true;
                        if (is_pay_done) return done_callback(is_ok);
                        return;
                    }
                    let fns = "";
                    block_hexes.forEach(function(block_hex) { fns += " block_share_dumps/" + block_hex + ".cvs" });
                    child_process.exec("./block_share_dumps/process.sh" + fns, function callback(error, stdout, stderr) {
                        if (error) console.error("./block_share_dumps/process.sh" + fns + ": returned error exit code: " + error.code + "\n" + stdout + "\n" + stderr);
                        else console.log("./block_share_dumps/process.sh" + fns + ": complete");
                        is_dump_done = true;
                        if (is_pay_done) return done_callback(is_ok);
                    });
                });
            } else {
                is_dump_done = true;
            }
        }

        const default_window     = blockDiff*global.config.pplns.shareMulti;
        const is_need_correction = Math.abs(totalPayments/default_window - 1) > 0.0001;
        const pay_window         = is_need_correction ? totalPayments : default_window;

        let add_count = 0;

        Object.keys(paymentData).forEach(function (key) {
            const payment = paymentData[key];
            if (payment.amount) {
                const paymentData2 = {
                    pool_type:      'pplns',
                    payment_address: payment.payment_address,
                    payment_id:      payment.payment_id,
                    bitcoin:         0,
                    amount:          payment.amount / pay_window,
                    hexes:           block_hexes,
                };
                ++ add_count;
                createBlockBalanceQueue.push(paymentData2, function (status) {
                    if (status === false) is_ok = false;
                    if (--add_count == 0) {
                        is_pay_done = true;
                        if (is_dump_done) return done_callback(is_ok);
                    }
                });
            }
        });

        console.log("PPLNS pre-payout cycle complete on block: " + block_height + " Payout Percentage: " + (totalPayments / pay_window) * 100 + "% (precisely " + totalPayments + " / " + pay_window + ")");
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

function doPPLNSPayments(block_hex, block_reward, block_port, block_timestamp, unlock_callback) {
    console.log("Performing PPLNS payout of block " + block_hex + " with value " + global.support.coinToDecimal(block_reward));
    global.mysql.query("SELECT SUM(amount) as amt FROM balance").then(function (rows) {
        if (typeof(rows[0]) === 'undefined' || typeof(rows[0].amt) === 'undefined') {
            console.error("SELECT SUM(amount) as amt FROM balance query returned undefined result");
            return;
        }
        prev_balance_sum = rows[0].amt;

        global.mysql.query("SELECT payment_address, payment_id, amount FROM block_balance WHERE hex = ?", [block_hex]).then(function (rows) {
            if (rows.length) {
                global.mysql.query("INSERT INTO paid_blocks (hex, amount, port, found_time) VALUES (?,?,?,?)", [block_hex, block_reward, parseInt(block_port), global.support.formatDate(block_timestamp)]).then(function () {
                    console.log("Adding total due to " + rows.length + " miners");
                    block_unlock_callback = unlock_callback;
                    rows.forEach(function (row) {
                        row.amount = Math.floor(row.amount * block_reward);
                        row.pool_type = "pplns";
                        row.bitcoin   = 0;
                        balanceQueue.push(row, function () {});
                    });
                }).catch(function (error) {
                    console.error("Block " + block_hex + " can not be inserted into paid_blocks table");
                });
            } else {
                console.error("Block " + block_hex + " has no payments in SQL");
            }
        });
    });
}

let payReadyBlockHashCalc = {};

function blockUnlocker(blockUnlockerCB) {
    if (is_full_stop) {
        debug("Dropping all block unlocks");
        return blockUnlockerCB();
    }
    if (paymentInProgress) {
        console.error("Skipping block unlocker run as there's a payment in progress");
        return blockUnlockerCB();
    }
    console.log("Running block unlocker");
    let blockList = global.database.getValidLockedBlocks();
    global.coinFuncs.getLastBlockHeader(function(err, body){
        if (err !== null) {
            console.error("Last block header request failed!");
            return blockUnlockerCB();
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
                    console.log("Invalidating block " + block.height + " due to being an orphan block");
                    return next();
                } else if (is_pplns_block && !(block.hash in payReadyBlockHashCalc) && block.pay_ready !== true) {
                    payReadyBlockHashCalc[block.hash] = 1;
                    preCalculatePPLNSPayments( [ block.hash ], block.height, block.difficulty, true, function(status) {
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
            return blockUnlockerCB();
        });
    });
}

function altblockUnlocker(altblockUnlockerCB) {
    if (is_full_stop) {
        debug("Dropping all altblock unlocks");
        return altblockUnlockerCB();
    }
    if (paymentInProgress) {
        console.error("Skipping altblock unlocker run as there's a payment in progress");
        return altblockUnlockerCB();
    }
    let blockList = global.database.getValidLockedAltBlocks();
    console.log("Running altblock unlocker for " + blockList.length + " blocks");
    let blockHeightWait = {};
    global.coinFuncs.getLastBlockHeader(function(err, body){
        if (err !== null) {
            console.error("Last block header request failed!");
            return altblockUnlockerCB();
        }
        const topBlockHeight = body.height;
        let preCalcAnchorBlockHashes = {};
        async.eachSeries(blockList, function(block, next) {
            if (topBlockHeight - block.anchor_height <= 60) return next();
            const is_pplns_block = block.poolType == global.protos.POOLTYPE.PPLNS;
            if (is_pplns_block && !(block.hash in payReadyBlockHashCalc) && block.pay_ready !== true) {
                if (block.value) {
                    const anchor_height = block.anchor_height - (block.anchor_height % global.config.payout.anchorRound);
                    if (!(anchor_height in preCalcAnchorBlockHashes)) preCalcAnchorBlockHashes[anchor_height] = [];
                    preCalcAnchorBlockHashes[anchor_height].push(block.hash);
                } else global.support.sendEmail(global.config.general.adminEmail, "FYI: blockManager saw zero value locked block",
                    "Hello,\r\nThe blockManager saw zero value locked block " + block.hash.toString('hex')
                );
                return next();
            } else if (!is_pplns_block || block.pay_ready === true) {
                if (block.pay_value !== 0) {
                    console.log(block.port + ": " + block.hash);
                    global.coinFuncs.getPortBlockHeaderByHash(block.port, block.hash, (err, body) => {
                        if ( ( body.topoheight && body.topoheight === -1) ||
                             body.confirmations === -1 ||
                             ( body.error instanceof Object && body.error.message === "The requested hash could not be found." )
                           ) {
                            global.database.invalidateAltBlock(block.id);
                            console.log("Invalidating altblock from " + block.port + " port for " + block.height + " due to being an orphan block");
                            return next();
                        } else if (err !== null && block.port != 8545) {
                            console.error("Can't get altblock of " + block.port + " port with " + block.height + " height");
                            global.coinFuncs.getPortBlockHeaderByID(block.port, block.height, (err, body) => {
                                if (err === null && body.hash !== block.hash) {
                                    global.database.invalidateAltBlock(block.id);
                                    console.log("Invalidating altblock from " + block.port + " port for " + block.height + " due to being an orphan block");
                                }
                                return next();
                            });
                        } else {
                            altblockPayments(block, function() { return next(); } );
                        }
                    });  
                } else {
                    if (!(block.port in blockHeightWait)) blockHeightWait[block.port] = [];
                    blockHeightWait[block.port].push(block.height);
                    return next();
                }
            } else {
                return next();
            }
            
        }, function() {
            console.log("Running altblock pre-payment for " + Object.keys(preCalcAnchorBlockHashes).length + " anchor heights");
            let maxPreCount = 10;
            async.eachSeries(Object.keys(preCalcAnchorBlockHashes), function(anchor_height, next) {
                if (--maxPreCount > 0) global.coinFuncs.getBlockHeaderByID(anchor_height, function (anchor_err, anchor_header) {
                    if (anchor_err === null){
                        const block_hexes = preCalcAnchorBlockHashes[anchor_height];
                        block_hexes.forEach(function (block_hex) {
                            payReadyBlockHashCalc[block_hex] = 1;
                        });
                        preCalculatePPLNSPayments(block_hexes, parseInt(anchor_height), anchor_header.difficulty, true, function(status) {
                            if (status) {
                                console.log("Completed PPLNS reward pre-calculations on altblock " + block_hexes.join(", ") + " on anchor height " + anchor_height + "\n");
                                block_hexes.forEach(function (block_hex) {
                                    global.database.payReadyAltBlock(block_hex);
                                });
                            }
                            return next();
                        });
                    } else {
                        console.error("Can't get correct anchor block header by height " + anchor_height);
                        return next();
                    }
                });
            }, function() {
                for (let port in blockHeightWait) {
                    console.log("Waiting for altblock with " + port + " port and " + blockHeightWait[port].join(", ") + " height(s) pay value");
                }
                return altblockUnlockerCB();
            });
        });
    });
}

function blockPayments(block, cb) {
    if (paymentInProgress) {
        console.error("Skipping payment as there's a payment in progress");
        return cb();
    }
    switch (block.poolType) {
        case global.protos.POOLTYPE.PPLNS:
            global.coinFuncs.getBlockHeaderByHash(block.hash, function (err, header) {
                if (err === null && block.height === header.height && block.value === header.reward && block.difficulty === header.difficulty){
                    if (paymentInProgress) {
                        console.error("Skipping payment as there's a payment in progress");
                        return cb();
                    }
                    paymentInProgress = true;
                    doPPLNSPayments(block.hash, block.value, global.config.daemon.port, block.timestamp, function() {
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
                if (err === null && block.height === header.height && block.value >= header.reward){
                    if (paymentInProgress) {
                        console.error("Skipping payment as there's a payment in progress");
                        return cb();
                    }
                    paymentInProgress = true;
                    doPPLNSPayments(block.hash, block.pay_value, block.port, block.timestamp, function() {
                        console.log("Unlocking " + block.port + " port block on " + block.height + " height with " + block.hash.toString('hex') + " hash");
                        global.database.unlockAltBlock(block.hash);
                        return cb();
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

function blockUnlockerNext() {
  altblockUnlocker(function() {
    setTimeout(blockUnlocker, 2*60*1000, blockUnlockerNext);
  });
}

blockUnlocker(blockUnlockerNext);
