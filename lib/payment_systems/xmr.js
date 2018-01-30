"use strict";
const shapeshift = require('shapeshift.io');
const async = require("async");
const debug = require("debug")("payments");
const request = require('request-json');
const range = require('range');

let hexChars = new RegExp("[0-9a-f]+");
let bestExchange = global.config.payout.bestExchange;
let xmrAPIClient = request.createClient('https://xmr.to/api/v1/xmr2btc/');

let is_full_stop = false;

function full_stop(err) {
    is_full_stop = true;
    console.error("Issue making payments: " + JSON.stringify(err));
    console.error("Will not make more payments until the payment daemon is restarted!");
    //toAddress, subject, body
    global.support.sendEmail(global.config.general.adminEmail, "Payment daemon unable to make payment",
      "Hello,\r\nThe payment daemon has hit an issue making a payment: " + JSON.stringify(err) +
      ".  Please investigate and restart the payment daemon as appropriate");
}

let shapeshiftQueue = async.queue(function (task, callback) {
    if (is_full_stop) {
        debug("Dropping all pending shapeshift payments");
        return;
    }

    // Amount needs to be shifted in as a non-completed value, as the wallet will only take non-complete values..
    let amount = task.amount - task.fee;
    // Address is the destination address IN BTC.
    let address = task.address;
    // PaymentIDs are the paymentID's to flag as paid by this transaction.
    // Should be a massive list of ID's so we can bulk-update them, by merging them with 's.
    // Here we go!  General process:  Scan shapeshift for valid amounts of funds to xfer around.
    // Once there's enough funds, then we active txn
    // Do a wallet call to xfer.
    // Setup a monitor on the transaction
    async.waterfall([
        function (intCallback) {
            // Verify if the coin is active in ShapeShift first.
            shapeshift.coins(function (err, coinData) {
                if (err) {
                    intCallback(err);
                } else if (!coinData.hasOwnProperty(global.config.general.coinCode) || coinData[global.config.general.coinCode].status !== "available") {
                    intCallback("Coin " + global.config.general.coinCode + " Is not available at this time on shapeshift.");
                } else {
                    intCallback(null);
                }
            });
        },
        function (intCallback) {
            // Get the market information from shapeshift, which includes deposit limits, minimum deposits, rates, etc.
            shapeshift.marketInfo(global.config.payout.shapeshiftPair, function (err, marketInfo) {
                if (err) {
                    intCallback(err);
                } else if (!marketInfo.hasOwnProperty("limit") || marketInfo.limit <= global.support.coinToDecimal(amount)) {
                    intCallback("Not enough coin in shapeshift to process at this time.");
                } else if (!marketInfo.hasOwnProperty("min") || marketInfo.min >= global.support.coinToDecimal(amount)) {
                    intCallback("Not enough coin to hit the shapeshift minimum deposits.");
                } else {
                    intCallback(null, marketInfo);
                }
            });
        },
        function (marketInfo, intCallback) {
            // Validated there's enough coin.  Time to make our dank txn.
            // Return:
            /*
             {
             "orderId": "cc49c556-e645-4c15-a943-d50a935274e4",
             "sAddress": "46yzCCD3Mza9tRj7aqPSaxVbbePtuAeKzf8Ky2eRtcXGcEgCg1iTBio6N4sPmznfgGEUGDoBz5CLxZ2XPTyZu1yoCAG7zt6",
             "deposit": "d8041668718e6e9d9d0fd335ee5ecd923e6fd074c41316d041cc18b779ade10e",
             "depositType": "XMR",
             "withdrawal": "1DbxcoCBSA9N7uZvkcvWxuLxSau9q9Pwiu",
             "withdrawalType": "BTC",
             "public": null,
             "apiPubKey": "shapeshift",
             "returnAddress": "46XWBqE1iwsVxSDP1qDrxhE1XvsZV6eALG5LwnoMdjbT4GPdy2bZTb99kagzxp2MMjUamTYZ4WgvZdFadvMimTjvR6Gv8hL",
             "returnAddressType": "XMR"
             }
             Valid Statuses:
             "received"
             "complete"
             "error"
             "no_deposits"
             Complete State Information:
             {
             "status": "complete",
             "address": "d8041668718e6e9d9d0fd335ee5ecd923e6fd074c41316d041cc18b779ade10e",
             "withdraw": "1DbxcoCBSA9N7uZvkcvWxuLxSau9q9Pwiu",
             "incomingCoin": 3,
             "incomingType": "XMR",
             "outgoingCoin": "0.04186155",
             "outgoingType": "BTC",
             "transaction": "be9d97f6fc75262151f8f63e035c6ed638b9eb2a4e93fef43ea63124b045dbfb"
             }
             */
            shapeshift.shift(address, global.config.payout.shapeshiftPair, {returnAddress: global.config.pool.address}, function (err, returnData) {
                if (err) {
                    intCallback(err);
                } else {
                    global.mysql.query("INSERT INTO shapeshiftTxn (id, address, paymentID, depositType, withdrawl, withdrawlType, returnAddress, returnAddressType, txnStatus) VALUES (?,?,?,?,?,?,?,?,?)",
                        [returnData.orderId, returnData.sAddress, returnData.deposit, returnData.depositType, returnData.withdrawl, returnData.withdrawlType, returnData.returnAddress, returnData.returnAddressType, 'no_deposits']).then(function () {
                        intCallback(null, marketInfo, returnData);
                    }).catch(function (error) {
                        intCallback(error);
                    });
                }
            });
        },
        function (marketInfo, shapeshiftTxnData, intCallback) {
            // Make the payment to ShapeShift
            let paymentDetails = {
                destinations: [
                    {
                        amount: amount,
                        address: shapeshiftTxnData.sAddress
                    }
                ],
                priority: global.config.payout.priority,
                mixin: global.config.payout.mixIn,
                payment_id: shapeshiftTxnData.deposit
            };
            debug("Payment Details: " + JSON.stringify(paymentDetails));
            paymentQueue.push(paymentDetails, function (body) {
                if (body.fee && body.fee > 10) {
                    intCallback(null, marketInfo, shapeshiftTxnData, body);
                } else {
                    intCallback("Unknown error from the wallet.");
                }
            });
        },
        function (marketInfo, shapeshiftTxnData, body, intCallback) {
            // body.tx_hash = XMR transaction hash.
            // Need to add transaction.
            global.mysql.query("INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees, exchange_rate, exchange_name, exchange_txn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [1, address, null, task.amount, body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, global.support.decimalToCoin(marketInfo.minerFee), 1, global.support.decimalToCoin(marketInfo.rate), 'shapeshift', shapeshiftTxnData.orderId]).then(function (result) {
                intCallback(null, result.insertId);
            }).catch(function (error) {
                intCallback(error);
            });
        }
    ], function (err, result) {
        if (err) {
            console.error("Error processing shapeshift txn: " + JSON.stringify(err));
            callback(true);
        } else {
            // Need to fill out this data pronto!
            console.log("Processed ShapeShift transaction for: " + address + " Paid out: " + result + " payments in the db");
            callback(null, result);
        }
    });
}, 2);

let xmrToQueue = async.queue(function (task, callback) {
    if (is_full_stop) {
        debug("Dropping all pending xmr.to payments");
        return;
    }

    // http://xmrto-api.readthedocs.io/en/latest/introduction.html
    // Documentation looks good!
    // Amount needs to be shifted in as a non-completed value, as the wallet will only take non-complete values..
    let amount = task.amount - task.fee;
    // Address is the destination address IN BTC.
    let address = task.address;
    // PaymentIDs are the paymentID's to flag as paid by this transaction.
    // Should be a massive list of ID's so we can bulk-update them, by merging them with 's.
    // Here we go!  General process:  Scan shapeshift for valid amounts of funds to xfer around.
    // Once there's enough funds, then we active txn
    // Do a wallet call to xfer.
    // Setup a monitor on the transaction
    async.waterfall([
        function (intCallback) {
            // Verify if XMR.to is ready to get to work.
            xmrAPIClient.get('order_parameter_query/', function (err, res, body) {
                if (err) {
                    return intCallback(err);
                } else if (body.error_msg) {
                    return intCallback(body.error_msg);
                } else {
                    let amtOfBTC = ((amount / global.config.general.sigDivisor) * body.price).toPrecision(5);
                    console.log("Attempting to pay: " + address + " Amount: " + amtOfBTC + " BTC or " + amount / global.config.general.sigDivisor + " XMR");
                    console.log("Response from XMR.to: " + JSON.stringify(body));
                    if (body.lower_limit >= amtOfBTC) {
                        return intCallback("Not enough XMR to hit the minimum deposit");
                    } else if (body.upper_limit <= amtOfBTC) {
                        return intCallback("Too much XMR to pay out to xmr.to");
                    } else {
                        return intCallback(null, amtOfBTC);
                    }
                }
            });
        },
        function (btcValue, intCallback) {
            // Validated there's enough coin.  Time to make our dank txn.
            // Return:
            /*
             {
             "state": "TO_BE_CREATED",
             "btc_amount": <requested_amount_in_btc_as_float>,
             "btc_dest_address": "<requested_destination_address_as_string>",
             "uuid": "<unique_order_identifier_as_12_character_string>"
             }
             Valid Statuses:
             "TO_BE_CREATED"
             "UNPAID"
             "UNDERPAID"
             "PAID_UNCONFIRMED"
             "PAID"
             "BTC_SENT"
             "TIMED_OUT"
             "NOT_FOUND"
             // Create, then immediately update with the new information w/ a status call.
             */
            console.log("Amount of BTC to pay: " + btcValue);
            xmrAPIClient.post('order_create/', {
                btc_amount: btcValue,
                btc_dest_address: address
            }, function (err, res, body) {
                if (err) {
                    return intCallback(err);
                } else if (body.error_msg) {
                    return intCallback(body.error_msg);
                } else {
                    return intCallback(null, body.uuid);
                }
            });
        },
        function (txnID, intCallback) {
            // This function only exists because xmr.to is a pretty little fucking princess.
            async.doUntil(function (xmrCallback) {
                    xmrAPIClient.post('order_status_query/', {uuid: txnID}, function (err, res, body) {
                        if (err) {
                            return intCallback(err);
                        } else if (body.error_msg) {
                            return intCallback(body.error_msg);
                        } else {
                            xmrCallback(null, body.state);
                        }
                    });
                },
                function (xmrCallback) {
                    return xmrCallback !== "TO_BE_CREATED";
                },
                function () {
                    intCallback(null, txnID);
                });
        },
        function (txnID, intCallback) {
            xmrAPIClient.post('order_status_query/', {uuid: txnID}, function (err, res, body) {
                if (err) {
                    return intCallback(err);
                } else if (body.error_msg) {
                    return intCallback(body.error_msg);
                } else {
                    console.log(JSON.stringify(body));
                    global.mysql.query("INSERT INTO xmrtoTxn (id, address, paymentID, depositType, withdrawl, withdrawlType, returnAddress, returnAddressType, txnStatus, amountDeposited, amountSent) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        [txnID, body.xmr_receiving_address, body.xmr_required_payment_id_long, 'XMR', body.btc_dest_address, 'BTC', global.config.pool.address, 'XMR', body.state_str, global.support.decimalToCoin(body.xmr_amount_total), global.support.decimalToCoin(body.btc_amount)]).then(function () {
                        return intCallback(null, body, global.support.decimalToCoin(body.xmr_amount_total));
                    }).catch(function (error) {
                        return intCallback(error);
                    });
                }
            });
        },
        function (orderStatus, xmrDeposit, intCallback) {
            // Make the payment to ShapeShift
            let paymentDetails = {
                destinations: [
                    {
                        amount: xmrDeposit,
                        address: orderStatus.xmr_receiving_address
                    }
                ],
                priority: global.config.payout.priority,
                mixin: global.config.payout.mixIn,
                payment_id: orderStatus.xmr_required_payment_id_long
            };
            debug("Payment Details: " + JSON.stringify(paymentDetails));
            paymentQueue.push(paymentDetails, function (body) {
                if (body.fee && body.fee > 10) {
                    return intCallback(null, orderStatus, body);
                } else {
                    return intCallback("Unknown error from the wallet.");
                }
            });
        },
        function (orderStatus, body, intCallback) {
            // body.tx_hash = XMR transaction hash.
            // Need to add transaction.
            global.mysql.query("INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees, exchange_rate, exchange_name, exchange_txn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [1, address, null, global.support.decimalToCoin(orderStatus.xmr_amount_total), body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, body.fee, 1, global.support.decimalToCoin(orderStatus.xmr_price_btc), 'xmrto', orderStatus.uuid]).then(function (result) {
                return intCallback(null, result.insertId);
            }).catch(function (error) {
                return intCallback(error);
            });
        }
    ], function (err, result) {
        if (err) {
            console.error("Error processing XMRTo txn: " + JSON.stringify(err));
            return callback("Error!");
        } else {
            // Need to fill out this data pronto!
            console.log("Processed XMRTo transaction for: " + address + " Paid out: " + result + " payments in the db");
            return callback(null, result);
        }
    });
}, 2);

let paymentQueue = async.queue(function (paymentDetails, callback) {
    if (is_full_stop) {
        debug("Dropping all pending payments");
        return;
    }

    /*
     support JSON URI: http://10.0.0.2:28082/json_rpc Args: {"id":"0","jsonrpc":"2.0","method":"transfer","params":{"destinations":[{"amount":68130252045355,"address":"A2MSrn49ziBPJBh8ZNEhhbfyLMou6mao4C1F5TLGUatmUnCxZArDYkcbAnVkVEopWVeak2rKDrmc8JpoS7n5dvfN9YDPBTG"}],"mixin":4,"payment_id":"7e52c5266de9fede7fb3abc0cd88f937b38b51426f7b34ff99729d28ce4e1142"}} +1ms
     payments Payment made: {"id":"0","jsonrpc":"2.0","result":{"fee":40199391255,"tx_hash":"c418708643f72635edf522490bfb2cae9d42a6dc1df30dcde844862dfd88f5b3","tx_key":""}} +2s
     */

    debug("Trying to make payment based on: " + JSON.stringify(paymentDetails));

    function getbalance() {
        global.support.rpcWallet("getbalance", paymentDetails, function (body) {
            if (body.hasOwnProperty('error') || !body.hasOwnProperty('result')) {
                console.error("Can't getbalance: " + JSON.stringify(body.error));
                setTimeout(getbalance, 60*1000);
                return;
            }
            if (body.result.unlocked_balance === 0) {
                console.log("Waiting for balance to unlock after previous payment");
                setTimeout(getbalance, 5*60*1000);
                return;
            }
            console.log("Current wallet balance is " + global.support.coinToDecimal(body.result.balance) + " with " + global.support.coinToDecimal(body.result.unlocked_balance) + " unlocked balance");

            let transferFunc = 'transfer';
            paymentDetails.get_tx_key = true;
            global.support.rpcWallet(transferFunc, paymentDetails, function (body) {
                debug("Payment made: " + JSON.stringify(body));
                if (body.hasOwnProperty('error') || !body.hasOwnProperty('result')) {
                    if (body.error.message === "not enough money"){
                        console.error("Issue making payments, not enough money, will try later");
                        setTimeout(getbalance, 10*60*1000);
                    } else {
                        full_stop(body.error);
                    }
                    return;
                }
                callback(body.result);
            });
        });
    };

    getbalance();

}, 1);

paymentQueue.drain = function(){
    console.log("Payment queue drained");
    global.database.setCache('lastPaymentCycle', Math.floor(Date.now()/1000));
};

function updateShapeshiftCompletion() {
    global.mysql.query("SELECT * FROM shapeshiftTxn WHERE txnStatus NOT IN ('complete', 'error')").then(function (rows) {
        rows.forEach(function (row) {
            shapeshift.status(row.paymentID, function (err, status, returnData) {
                if (err) {
                    return;
                }
                global.mysql.query("UPDATE shapeshiftTxn SET txnStatus = ? WHERE id = ?", [status, row.id]).then(function () {
                    if (status === 'complete') {
                        global.mysql.query("UPDATE shapeshiftTxn SET amountDeposited = ?, amountSent = ?, transactionHash = ? WHERE id = ?",
                            [global.support.decimalToCoin(returnData.incomingCoin), global.support.bitcoinDecimalToCoin(returnData.outgoingCoin), returnData.transaction, row.id]).then(function () {
                            global.mysql.query("UPDATE transactions SET confirmed = 1, confirmed_time = now(), btc_amt = ? WHERE exchange_txn_id = ?", [global.support.bitcoinDecimalToCoin(returnData.outgoingCoin), row.id]);
                        });
                    } else if (status === 'error') {
                        // Failed txn.  Need to rollback and delete all related data.  Here we go!
                        global.mysql.query("DELETE FROM shapeshiftTxn WHERE id = ?", [row.id]);
                        global.mysql.query("SELECT id, xmr_amt, address FROM transactions WHERE exchange_txn_id = ?", [row.id]).then(function (rows) {
                            global.mysql.query("DELETE FROM transactions WHERE id = ?", [rows[0].id]);
                            global.mysql.query("DELETE payments WHERE transaction_id = ?", [rows[0].id]);
                            global.mysql.query("UPDATE balance SET amount = amount+? WHERE payment_address = ? limit 1", [rows[0].xmr_amt, rows[0].address]);
                        });
                        console.error("Failed transaction from ShapeShift " + JSON.stringify(returnData));
                    }
                });
            });
        });
    });
}

function updateXMRToCompletion() {
    global.mysql.query("SELECT * FROM xmrtoTxn WHERE txnStatus NOT IN ('PAID', 'TIMED_OUT', 'NOT_FOUND', 'BTC_SENT')").then(function (rows) {
        rows.forEach(function (row) {
            xmrAPIClient.post('order_status_query/', {uuid: row.id}, function (err, res, body) {
                if (err) {
                    console.log("Error in getting order status: " + JSON.stringify(err));
                    return;
                }
                if (body.error_msg) {
                    console.log("Error in getting order status: " + body.error_msg);
                    return;
                }
                global.mysql.query("UPDATE xmrtoTxn SET txnStatus = ? WHERE id = ?", [body.state, row.id]).then(function () {
                    if (body.status === 'BTC_SENT') {
                        global.mysql.query("UPDATE xmrtoTxn SET transactionHash = ? WHERE id = ?", [body.btc_transaction_id, row.id]).then(function () {
                            global.mysql.query("UPDATE transactions SET confirmed = 1, confirmed_time = now(), btc_amt = ? WHERE exchange_txn_id = ?", [global.support.bitcoinDecimalToCoin(body.btc_amount), row.id]);
                        });
                    } else if (body.status === 'TIMED_OUT' || body.status === 'NOT_FOUND') {
                        global.mysql.query("DELETE FROM xmrtoTxn WHERE id = ?", [row.id]);
                        global.mysql.query("SELECT id, xmr_amt, address FROM transactions WHERE exchange_txn_id = ?", [row.id]).then(function (rows) {
                            global.mysql.query("DELETE FROM transactions WHERE id = ?", [rows[0].id]);
                            global.mysql.query("DELETE payments WHERE transaction_id = ?", [rows[0].id]);
                            global.mysql.query("UPDATE balance SET amount = amount+? WHERE payment_address = ? limit 1", [rows[0].xmr_amt, rows[0].address]);
                        });
                        console.error("Failed transaction from XMRto " + JSON.stringify(body));
                    }
                });
            });
        });
    });
}

function determineBestExchange() {
    async.waterfall([
        function (callback) {
            // Verify if the coin is active in ShapeShift first.
            shapeshift.coins(function (err, coinData) {
                if (err) {
                    return callback(err);
                } else if (!coinData.hasOwnProperty(global.config.general.coinCode) || coinData[global.config.general.coinCode].status !== "available") {
                    return callback("Coin " + global.config.general.coinCode + " Is not available at this time on shapeshift.");
                } else {
                    return callback(null);
                }
            });
        },
        function (callback) {
            // Get the market information from shapeshift, which includes deposit limits, minimum deposits, rates, etc.
            shapeshift.marketInfo(global.config.payout.shapeshiftPair, function (err, marketInfo) {
                if (err) {
                    return callback(err);
                } else if (!marketInfo.hasOwnProperty("rate")) {
                    return callback("Shapeshift did not return the rate.");
                } else {
                    return callback(null, global.support.bitcoinDecimalToCoin(marketInfo.rate));
                }
            });
        },
        function (ssValue, callback) {
            xmrAPIClient.get('order_parameter_query/', function (err, res, body) {
                console.log("XMR.to pricing body: " + JSON.stringify(body));
                if (err) {
                    return callback(err);
                } else if (body.error_msg) {
                    return callback(body.error_msg);
                } else {
                    return callback(null, ssValue, global.support.bitcoinDecimalToCoin(body.price));
                }
            });
        }
    ], function (err, ssValue, xmrToValue) {
        if (err) {
            return console.error("Error processing exchange value: " + JSON.stringify(err));
        }
        debug("ShapeShift Value: " + global.support.bitcoinCoinToDecimal(ssValue) + " XMR.to Value: " + global.support.bitcoinCoinToDecimal(xmrToValue));
        if (ssValue >= xmrToValue) {
            console.log("ShapeShift is the better BTC exchange, current rate: " + global.support.bitcoinCoinToDecimal(ssValue));
            bestExchange = 'shapeshift';
            global.mysql.query("UPDATE config SET item_value = 'shapeshift' where item='bestExchange'");
            global.mysql.query("UPDATE config SET item_value = ? where item='exchangeRate'", [ssValue]);
        } else {
            console.log("XMR.to is the better BTC exchange, current rate: " + global.support.bitcoinCoinToDecimal(xmrToValue));
            bestExchange = 'xmrto';
            global.mysql.query("UPDATE config SET item_value = 'xmrto' where item='bestExchange'");
            global.mysql.query("UPDATE config SET item_value = ? where item='exchangeRate'", [xmrToValue]);
        }
    });
}

function Payee(amount, address, paymentID, bitcoin) {
    this.amount = amount;
    this.address = address;
    this.paymentID = paymentID;
    this.bitcoin = bitcoin;
    this.blockID = 0;
    this.poolType = '';
    this.transactionID = 0;
    this.sqlID = 0;
    if (paymentID === null) {
        this.id = address;
    } else {
        this.id = address + "." + paymentID;
    }
    this.fee = 0;
    this.baseFee = global.support.decimalToCoin(global.config.payout.feeSlewAmount);
    this.setFeeAmount = function () {
        if (this.amount <= global.support.decimalToCoin(global.config.payout.walletMin)) {
            this.fee = this.baseFee;
        } else if (this.amount <= global.support.decimalToCoin(global.config.payout.feeSlewEnd)) {
            let feeValue = this.baseFee / (global.support.decimalToCoin(global.config.payout.feeSlewEnd) - global.support.decimalToCoin(global.config.payout.walletMin));
            this.fee = this.baseFee - ((this.amount - global.support.decimalToCoin(global.config.payout.walletMin)) * feeValue);
        }
        this.fee = Math.floor(this.fee);
    };

    this.makePaymentWithID = function () {
        let paymentDetails = {
            destinations: [
                {
                    amount: this.amount - this.fee,
                    address: this.address
                }
            ],
            priority: global.config.payout.priority,
            mixin: global.config.payout.mixIn,
            payment_id: this.paymentID
        };
        let identifier = this.id;
        let amount = this.amount;
        let fee = this.fee;
        let address = this.address;
        let paymentID = this.paymentID;
        let payee = this;
        debug("Payment Details: " + JSON.stringify(paymentDetails));
        paymentQueue.push(paymentDetails, function (body) {
            if (body.fee && body.fee > 10) {
                console.log("[*] Successful payment to " + identifier + " of " + global.support.coinToDecimal(amount) + " XMR (fee " + global.support.coinToDecimal(fee) + " - " + global.support.coinToDecimal(body.fee) + " = " + global.support.coinToDecimal(fee - body.fee) + ") with tx_hash " + body.tx_hash.match(hexChars)[0] + " and tx_key " + body.tx_key);
                global.mysql.query("INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [0, address, paymentID, amount, body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, body.fee, 1]).then(function (result) {
                    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                        console.error("Can't do: INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (0, '"
                            + address + "', '" + paymentID + "', " + amount + ", '" + body.tx_hash.match(hexChars)[0] + "', " + global.config.payout.mixIn + ", " + body.fee + ", 1)"
                        );
                        payee.transactionID = 0;
                        payee.manualPaymentShow();
                        full_stop(result);
                        return;
                    }
                    payee.transactionID = result.insertId;
                    payee.trackPayment();
                });
            } else {
                console.error("Unknown error from the wallet: " + JSON.stringify(body));
            }
        });
    };

    this.makePaymentAsIntegrated = function () {
        let paymentDetails = {
            destinations: [
                {
                    amount: this.amount - this.fee,
                    address: this.address
                }
            ],
            priority: global.config.payout.priority,
            mixin: global.config.payout.mixIn
        };
        let identifier = this.id;
        let amount = this.amount;
        let fee = this.fee;
        let address = this.address;
        let payee = this;

        debug("Payment Details: " + JSON.stringify(paymentDetails));
        paymentQueue.push(paymentDetails, function (body) {
            if (body.fee && body.fee > 10) {
                console.log("[*] Successful payment to " + identifier + " of " + global.support.coinToDecimal(amount) + " XMR (fee " + global.support.coinToDecimal(fee) + " - " + global.support.coinToDecimal(body.fee) + " = " + global.support.coinToDecimal(fee - body.fee) + ") with tx_hash " + body.tx_hash.match(hexChars)[0] + " and tx_key " + body.tx_key);
                global.mysql.query("INSERT INTO transactions (bitcoin, address, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [0, address, amount, body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, body.fee, 1]).then(function (result) {
                    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                        console.error("Can't do: INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (0, '"
                            + address + "', " + amount + ", '" + body.tx_hash.match(hexChars)[0] + "', " + global.config.payout.mixIn + ", " + body.fee + ", 1)"
                        );
                        payee.transactionID = 0;
                        payee.manualPaymentShow();
                        full_stop(result);
                        return;
                    }
                    payee.transactionID = result.insertId;
                    payee.trackPayment();
                });
            } else {
                console.error("Unknown error from the wallet: " + JSON.stringify(body));
            }
        });
    };

    this.makeBitcoinPayment = function () {
        let functionalData = {address: this.address, amount: this.amount, fee: this.fee};
        let payee = this;
        if (bestExchange === 'xmrto') {
            xmrToQueue.push(functionalData, function (err, transactionID) {
                if (err) {
                    return console.error("Error processing payment for " + functionalData.address);
                }
                payee.transactionID = transactionID;
                payee.trackPayment();
            });
        } else {
            shapeshiftQueue.push(functionalData, function (err, transactionID) {
                if (err) {
                    return console.error("Error processing payment for " + functionalData.address);
                }
                payee.transactionID = transactionID;
                payee.trackPayment();
            });
        }
    };

    this.manualPaymentShow = function () {
        console.error("Manual payment update:");
        console.error("  UPDATE balance SET amount = amount - " + this.amount + "  WHERE id = " + this.sqlID + ";");
        console.error("  INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, bitcoin, amount, payment_id, transfer_fee) VALUES (now(), now(), "
          + this.poolType + ", " + this.address + ", " + this.transactionID + ", " + this.bitcoin + ", " + (this.amount - this.fee) + ", " + this.paymentID + ", " + this.fee + ");"
        );
    };

    this.trackPayment = function () {
        global.mysql.query("UPDATE balance SET amount = amount - ? WHERE id = ?", [this.amount, this.sqlID]).then(function (result) {
            if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
               console.error("Can't do SQL balance update");
               this.manualPaymentShow();
               full_stop(result);
            }
        });
        global.mysql.query("INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, bitcoin, amount, payment_id, transfer_fee)" +
            " VALUES (now(), now(), ?, ?, ?, ?, ?, ?, ?)", [this.poolType, this.address, this.transactionID, this.bitcoin, this.amount - this.fee, this.paymentID, this.fee]).then(function (result) {
            if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
               console.error("Can't do SQL payments update");
               this.manualPaymentShow();
               full_stop(result);
            }
        });
    };
}

function makePayments() {
    if (is_full_stop) {
        debug("Dropping all new payment creation");
        return;
    }
    if (paymentQueue.idle() === false) {
        debug("Payment queue is not empty so dropping all new payment creation");
        return;
    }
    if (shapeshiftQueue.idle() === false) {
        debug("Shapeshift payment queue is not empty so dropping all new payment creation");
        return;
    }
    if (xmrToQueue.idle() === false) {
        debug("xmr.to payment queue is not empty so dropping all new payment creation");
        return;
    }

    debug("Starting makePayments");
    global.mysql.query("SELECT * FROM balance WHERE amount >= ?", [global.support.decimalToCoin(global.config.payout.walletMin)]).then(function (rows) {
        console.log("Loaded all payees into the system for processing");
        let paymentDestinations = [];
        let totalAmount = 0;
        let roundCount = 0;
        let payeeList = [];
        let payeeObjects = {};
        rows.forEach(function (row) {
            //debug("Starting round for: " + JSON.stringify(row));
            let payee = new Payee(row.amount, row.payment_address, row.payment_id, row.bitcoin);
            payeeObjects[row.payment_address] = payee;
            global.mysql.query("SELECT payout_threshold FROM users WHERE username = ?", [payee.id]).then(function (userRow) {
                roundCount += 1;
                let threshold = global.support.decimalToCoin(0.3);
                let custom_threshold = false;
                if (userRow.length !== 0 && userRow[0].payout_threshold != 0) {
                    threshold = userRow[0].payout_threshold;
                    custom_threshold = true;
                }
                payee.poolType = row.pool_type;
                payee.sqlID = row.id;
                if (payee.poolType === "fees" && payee.address === global.config.payout.feeAddress && payee.amount >= ((global.support.decimalToCoin(global.config.payout.feesForTXN) + global.support.decimalToCoin(global.config.payout.exchangeMin)))) {
                    debug("This is the fee address internal check for value");
                    payee.amount -= global.support.decimalToCoin(global.config.payout.feesForTXN);
                } else if (payee.address === global.config.payout.feeAddress && payee.poolType === "fees") {
                    debug("Unable to pay fee address.");
                    payee.amount = 0;
                }
                let remainder = payee.amount % (global.config.payout.denom * global.config.general.sigDivisor);
                if (remainder !== 0) {
                    payee.amount -= remainder;
                }
                if (payee.amount > threshold) {
                    payee.setFeeAmount();
                    if (payee.bitcoin === 0 && payee.paymentID === null && payee.amount !== 0 && payee.amount > 0 && payee.address.length !== 106) {
                        debug("Adding " + payee.id + " to the list of people to pay (OG Address).  Payee balance: " + global.support.coinToDecimal(payee.amount));
                        paymentDestinations.push({amount: payee.amount - payee.fee, address: payee.address});
                        totalAmount += payee.amount;
                        payeeList.push(payee);
                    } else if (payee.bitcoin === 0 && payee.paymentID === null && payee.amount !== 0 && payee.amount > 0 && payee.address.length === 106 && (payee.amount >= global.support.decimalToCoin(global.config.payout.exchangeMin) || (payee.amount > threshold && custom_threshold))) {
                        // Special code to handle integrated payment addresses.  What a pain in the rear.
                        // These are exchange addresses though, so they need to hit the exchange payout amount.
                        debug("Adding " + payee.id + " to the list of people to pay (Integrated Address).  Payee balance: " + global.support.coinToDecimal(payee.amount));
                        payee.makePaymentAsIntegrated();
                    } else if ((payee.amount >= global.support.decimalToCoin(global.config.payout.exchangeMin) || (payee.amount > threshold && custom_threshold)) && payee.bitcoin === 0) {
                        debug("Adding " + payee.id + " to the list of people to pay (Payment ID Address).  Payee balance: " + global.support.coinToDecimal(payee.amount));
                        payee.makePaymentWithID();
                    } else if ((payee.amount >= global.support.decimalToCoin(global.config.payout.exchangeMin) || (payee.amount > threshold && custom_threshold)) && payee.bitcoin === 1) {
                        debug("Adding " + payee.id + " to the list of people to pay (Bitcoin Payout).  Payee balance: " + global.support.coinToDecimal(payee.amount));
                        payee.makeBitcoinPayment();
                    }
                }
                //debug("Went: " + roundCount + " With: " + paymentDestinations.length + " Possible destinations and: " + rows.length + " Rows");
                if (roundCount === rows.length && paymentDestinations.length > 0) {
                    debug("Doing payment to multiple people: " + paymentDestinations.length);
                    while (paymentDestinations.length > 0) {
                        let paymentDetails = {
                            destinations: paymentDestinations.splice(0, global.config.payout.maxPaymentTxns),
                            priority: global.config.payout.priority,
                            mixin: global.config.payout.mixIn
                        };
                        console.log("Paying out: " + paymentDetails.destinations.length + " people");
                        paymentQueue.push(paymentDetails, function (body) {  //jshint ignore:line
                            // This is the only section that could potentially contain multiple txns.  Lets do this safely eh?
                            if (body.fee && body.fee > 10) {
                                let totalAmount = 0;
                                let totalFee = 0;
                                paymentDetails.destinations.forEach(function (payeeItem) {
                                    totalAmount += payeeObjects[payeeItem.address].amount;
                                    totalFee    += payeeObjects[payeeItem.address].fee;
                                    console.log("[**] Successful payment to " + payeeItem.address + " for " + global.support.coinToDecimal(payeeObjects[payeeItem.address].amount) + " XMR (fee " + global.support.coinToDecimal(payeeObjects[payeeItem.address].fee) + ")");
                                });
                                console.log("[*] Successful payment to multiple miners of " + global.support.coinToDecimal(totalAmount) + " XMR (fee " + global.support.coinToDecimal(totalFee) + " - " + global.support.coinToDecimal(body.fee) + " = " + global.support.coinToDecimal(totalFee - body.fee) + ") with tx_hash " + body.tx_hash.match(hexChars)[0] + " and tx_key " + body.tx_key);
                                global.mysql.query("INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                    [0, null, null, totalAmount, body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, body.fee, paymentDetails.destinations.length]).then(function (result) {
                                    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                                        console.error("Can't do: INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (0, null, null, "
                                            + totalAmount + ", '" + body.tx_hash.match(hexChars)[0] + "', " + global.config.payout.mixIn + ", " + body.fee + ", " + paymentDetails.destinations.length + ")"
                                        );
                                        paymentDetails.destinations.forEach(function (payeeItem) {
                                            payee = payeeObjects[payeeItem.address];
                                            payee.transactionID = 0;
                                            payee.manualPaymentShow();
                                        });
                                        full_stop(result);
                                        return;
                                    }
                                    paymentDetails.destinations.forEach(function (payeeItem) {
                                        payee = payeeObjects[payeeItem.address];
                                        payee.transactionID = result.insertId;
                                        payee.trackPayment();
                                    });
                                });
                            } else {
                                console.error("Unknown error from the wallet: " + JSON.stringify(body));
                            }
                        });
                    }
                }
                if (roundCount === rows.length) debug("Finished processing payments for now");
            });
        });
    });
    debug("Finished makePayments");
}

function init() {
    global.support.rpcWallet("store", [], function () {});
    if (global.config.allowBitcoin) {
        determineBestExchange();
        setInterval(updateXMRToCompletion, 90000);
        setInterval(updateShapeshiftCompletion, 90000);
        setInterval(determineBestExchange, 60000);
    }
    setInterval(function () {
        global.support.rpcWallet("store", [], function () {});
    }, 60*1000);

    setInterval(function () {
       console.log("Payment queue lengths: payment (" + (paymentQueue.running() + paymentQueue.length()) + ") / shapeshift (" + (shapeshiftQueue.running() + shapeshiftQueue.length()) + ") / xmr.to (" + (xmrToQueue.running() + xmrToQueue.length()) + ")");
    }, 10*60*1000);

    makePayments();

    console.log("Setting the payment timer to: " + global.config.payout.timer + " minutes");
    setInterval(makePayments, global.config.payout.timer * 60 * 1000);
}

if (global.config.payout.timer > 35791) {
    console.error("Payout timer is too high. Please use a value under 35791 to avoid overflows.");
} else {
    init();
}