"use strict";
const async = require("async");
const debug = require("debug")("payments");
const request = require('request-json');
const range = require('range');
const sprintf = require("sprintf-js").sprintf;

let hexChars = new RegExp("[0-9a-f]+");

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
            if (body.hasOwnProperty('error') || !body.hasOwnProperty('result') || typeof(body.result) === 'undefined' || !body.result.hasOwnProperty('unlocked_balance') || typeof(body.result.unlocked_balance) !== "number") {
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
                    if ( typeof(body.error) !== 'undefined' &&
                         body.error.hasOwnProperty('message') &&
                         ( body.error.message === "not enough money" ||
                           body.error.message === "not enough unlocked money" ||
                           body.error.message === "transaction was rejected by daemon"
                         )
                       ) {
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

paymentQueue.drain(function(){
    console.log("Payment queue drained");
    global.database.setCache('lastPaymentCycle', Math.floor(Date.now()/1000));
});

function Payee(amount, address, paymentID) {
    this.amount = amount;
    this.address = address;
    this.paymentID = paymentID;
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
                global.mysql.query("INSERT INTO transactions (address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [address, paymentID, amount, body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, body.fee, 1]).then(function (result) {
                    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                        console.error("Can't do: INSERT INTO transactions (address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES ('"
                            + address + "', '" + paymentID + "', " + amount + ", '" + body.tx_hash.match(hexChars)[0] + "', " + global.config.payout.mixIn + ", " + body.fee + ", 1)"
                        );
                        payee.transactionID = 0;
                        payee.manualPaymentShow();
                        full_stop(result);
                        return;
                    }
                    payee.transactionID = result.insertId;
                    payee.tx_hash = body.tx_hash.match(hexChars)[0];
                    payee.tx_key = body.tx_key;
                    payee.trackPayment();
                }).catch(function (error) {
                    console.error("SQL query failed: " + error);
                    console.error("Can't do: INSERT INTO transactions (address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES ('"
                        + address + "', '" + paymentID + "', " + amount + ", '" + body.tx_hash.match(hexChars)[0] + "', " + global.config.payout.mixIn + ", " + body.fee + ", 1)"
                    );
                    payee.transactionID = 0;
                    payee.manualPaymentShow();
                    full_stop(result);
                    return;
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
                global.mysql.query("INSERT INTO transactions (address, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?)",
                    [address, amount, body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, body.fee, 1]).then(function (result) {
                    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                        console.error("Can't do: INSERT INTO transactions (address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES ('"
                            + address + "', " + amount + ", '" + body.tx_hash.match(hexChars)[0] + "', " + global.config.payout.mixIn + ", " + body.fee + ", 1)"
                        );
                        payee.transactionID = 0;
                        payee.manualPaymentShow();
                        full_stop(result);
                        return;
                    }
                    payee.transactionID = result.insertId;
                    payee.tx_hash = body.tx_hash.match(hexChars)[0];
                    payee.tx_key = body.tx_key;
                    payee.trackPayment();
                }).catch(function (error) {
                    console.error("SQL query failed: " + error);
                    console.error("Can't do: INSERT INTO transactions (address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES ('"
                        + address + "', " + amount + ", '" + body.tx_hash.match(hexChars)[0] + "', " + global.config.payout.mixIn + ", " + body.fee + ", 1)"
                    );
                    payee.transactionID = 0;
                    payee.manualPaymentShow();
                    full_stop(result);
                    return;
                });
            } else {
                console.error("Unknown error from the wallet: " + JSON.stringify(body));
            }
        });
    };

    this.manualPaymentShow = function () {
        console.error("Manual payment update:");
        console.error("  UPDATE balance SET amount = amount - " + this.amount + "  WHERE id = " + this.sqlID + ";");
        console.error("  INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, amount, payment_id, transfer_fee) VALUES (now(), now(), "
          + this.poolType + ", " + this.address + ", " + this.transactionID + ", " + (this.amount - this.fee) + ", " + this.paymentID + ", " + this.fee + ");"
        );
    };

    this.trackPayment = function () {
        global.mysql.query("UPDATE balance SET amount = amount - ? WHERE id = ?", [this.amount, this.sqlID]).then(function (result) {
            if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
               console.error("Can't do SQL balance update");
               this.manualPaymentShow();
               full_stop(result);
            }
        }).catch(function (error) {
            console.error("SQL query failed: " + error);
            console.error("Can't do SQL balance update");
            this.manualPaymentShow();
            full_stop(result);
        });
        global.mysql.query("INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, amount, payment_id, transfer_fee)" +
            " VALUES (now(), now(), ?, ?, ?, ?, ?, ?)", [this.poolType, this.address, this.transactionID, this.amount - this.fee, this.paymentID, this.fee]).then(function (result) {
            if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
               console.error("Can't do SQL payments update");
               this.manualPaymentShow();
               full_stop(result);
            }
        }).catch(function (error) {
           console.error("SQL query failed: " + error);
           console.error("Can't do SQL payments update");
           this.manualPaymentShow();
           full_stop(result);
        });

        let payee = this;

        global.mysql.query("SELECT email FROM users WHERE username = ? AND enable_email IS true limit 1", [payee.id]).then(function (rows) {
            if (rows.length === 0) return;
            // toAddress, subject, body
            let emailData = {
                address:  payee.address,
                address2: payee.id,
                payment_amount: global.support.coinToDecimal(payee.amount - payee.fee),
                amount: global.support.coinToDecimal(payee.amount),
                fee: global.support.coinToDecimal(payee.fee),
                tx_hash: payee.tx_hash,
                tx_key: payee.tx_key
            };
            global.support.sendEmail(rows[0].email,
                sprintf("Your %(payment_amount)s XMR payment was just performed", emailData),
                sprintf(
                    "Your payment of %(payment_amount)s XMR (with tx fee %(fee)s XMR) to %(address2)s wallet was just performed and total due was decreased by %(amount)s XMR.\n" +
                    (payee.tx_hash && payee.tx_key ?
                        "Your payment tx_hash (tx_id) is %(tx_hash)s and tx_key is %(tx_key)s (can be used to verify payment)\n" +
                        "Here is link to verify that this payment was made: https://xmrchain.net/prove/%(tx_hash)s/%(address)s/%(tx_key)s\n" +
                        "You can also check that in your command line (cli) wallet using \"check_tx_key %(tx_hash)s %(tx_key)s %(address)s\" command " +
                        "(see https://getmonero.org/resources/user-guides/prove-payment.html for more details)\n"
                        : ""
                    ),
                    emailData
                ),
                payee.id
            );
        }).catch(function (error) {
           console.error("SQL query failed: " + error);
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

    console.log("Starting makePayments");
    global.mysql.query("SELECT * FROM balance WHERE amount >= ?", [global.support.decimalToCoin(global.config.payout.walletMin)]).then(function (rows) {
        console.log("Loaded all payees into the system for processing");
        let paymentDestinations = [];
        let totalAmount = 0;
        let payeeObjects = {};
        async.eachSeries(rows, function(row, next) {
            //debug("Starting round for: " + JSON.stringify(row));
            if ((row.payment_address + (row.payment_id ? ('.' + row.payment_id) : '')) in payeeObjects) return next(); // avoid doing payment for different pool types at the same time
            let payee = new Payee(row.amount, row.payment_address, row.payment_id);
            global.mysql.query("SELECT payout_threshold FROM users WHERE username = ?", [payee.id]).then(function (userRow) {
                let threshold = global.support.decimalToCoin(global.config.payout.defaultPay);
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
                if (payee.amount >= threshold) {
                    payee.setFeeAmount();
                    if (payee.paymentID === null && payee.amount !== 0 && payee.amount > 0) {
                        if (payee.address.length !== 106 ) {
                            payeeObjects[payee.id] = payee;
                            console.log("[++] " + payee.id + " miner to bulk payment. Amount: " + global.support.coinToDecimal(payee.amount));
                            paymentDestinations.push({amount: payee.amount - payee.fee, address: payee.address});
                            totalAmount += payee.amount;
                        } else if (   payee.amount >= global.support.decimalToCoin(global.config.payout.exchangeMin) ||
                                      ( payee.amount > threshold && custom_threshold )
                                  ) {
                            // Special code to handle integrated payment addresses.  What a pain in the rear.
                            // These are exchange addresses though, so they need to hit the exchange payout amount.
                            payeeObjects[payee.id] = payee;
                            console.log("[+] " + payee.id + " as separate payment to integrated address. Amount: " + global.support.coinToDecimal(payee.amount));
                            payee.makePaymentAsIntegrated();
                        }
                    }
                }
                return next();
            }).catch(function (error) {
                console.error("SQL query failed: " + error);
            });
        }, function() {
            while (paymentDestinations.length > 0) {
                let paymentDetails = {
                    destinations: paymentDestinations.splice(0, global.config.payout.maxPaymentTxns),
                    priority: global.config.payout.priority,
                    mixin: global.config.payout.mixIn
                };
                console.log("Adding payment for " + paymentDetails.destinations.length + " miners");
                paymentQueue.unshift(paymentDetails, function (body) {  //jshint ignore:line
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
                        global.mysql.query("INSERT INTO transactions (address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            [null, null, totalAmount, body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, body.fee, paymentDetails.destinations.length]).then(function (result) {
                            if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                                console.error("Can't do: INSERT INTO transactions (address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (null, null, "
                                    + totalAmount + ", '" + body.tx_hash.match(hexChars)[0] + "', " + global.config.payout.mixIn + ", " + body.fee + ", " + paymentDetails.destinations.length + ")"
                                );
                                paymentDetails.destinations.forEach(function (payeeItem) {
                                    let payee = payeeObjects[payeeItem.address];
                                    payee.transactionID = 0;
                                    payee.manualPaymentShow();
                                });
                                full_stop(result);
                                return;
                            }
                            paymentDetails.destinations.forEach(function (payeeItem) {
                                let payee = payeeObjects[payeeItem.address];
                                payee.transactionID = result.insertId;
                                payee.tx_hash = body.tx_hash.match(hexChars)[0];
                                payee.tx_key = body.tx_key;
                                payee.trackPayment();
                            });
                        }).catch(function (error) {
                            console.error("SQL query failed: " + error);
                            console.error("Can't do: INSERT INTO transactions (address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (null, null, "
                                + totalAmount + ", '" + body.tx_hash.match(hexChars)[0] + "', " + global.config.payout.mixIn + ", " + body.fee + ", " + paymentDetails.destinations.length + ")"
                            );
                            paymentDetails.destinations.forEach(function (payeeItem) {
                                let payee = payeeObjects[payeeItem.address];
                                payee.transactionID = 0;
                                payee.manualPaymentShow();
                            });
                            full_stop(result);
                            return;
                        });
                    } else {
                        console.error("Unknown error from the wallet: " + JSON.stringify(body));
                    }
                });
            }
            debug("Finished processing payments for now");
        });
    }).catch(function (error) {
        console.error("SQL query failed: " + error);
    });
    debug("Finished makePayments");
}

function init() {
    global.support.rpcWallet("store", [], function () {});
    setInterval(function () {
        global.support.rpcWallet("store", [], function () {});
    }, 60*1000);

    setInterval(function () {
       console.log("Payment queue lengths: payment (" + (paymentQueue.running() + paymentQueue.length()) + ")");
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
