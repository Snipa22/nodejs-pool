"use strict";
const async = require("async");
const debug = require("debug")("payments");

let hexChars = new RegExp("[0-9a-f]+");
let extraPaymentRound = false;
let paymentTimer = null;

let paymentQueue = async.queue(function (paymentDetails, callback) {
    if (paymentTimer !== null){
        clearInterval(paymentTimer);
        paymentTimer = null;
    }
    debug("Making payment based on: " + JSON.stringify(paymentDetails));
    let transferFunc = 'transfer';
    global.support.rpcWallet(transferFunc, paymentDetails, function (body) {
        debug("Payment made: " + JSON.stringify(body));
        if (body.hasOwnProperty('error')) {
            if (body.error.message === "not enough money"){
                console.error("Issue making payments, not enough money, will try later");
                if(!extraPaymentRound){
                    setTimeout(function(){
                        makePayments();
                    }, global.config.payout.timerRetry * 60 * 1000);
                }
                extraPaymentRound = true;
                return callback(false);
            } else {
                console.error("Issue making payments" + JSON.stringify(body.error));
                console.error("Will not make more payments until the payment daemon is restarted!");
                //toAddress, subject, body
                global.support.sendEmail(global.config.general.adminEmail, "Payment daemon unable to make payment",
                    "Hello,\r\nThe payment daemon has hit an issue making a payment: " + JSON.stringify(body.error) +
                    ".  Please investigate and restart the payment daemon as appropriate");
                return;
            }
        }
        if (paymentDetails.hasOwnProperty('payment_id')) {
            console.log("Payment made to " + paymentDetails.destinations[0].address + " with PaymentID: " + paymentDetails.payment_id + " For: " + global.support.coinToDecimal(paymentDetails.destinations[0].amount) + " XMR with a " + global.support.coinToDecimal(body.result.fee) + " XMR Mining Fee");
            return callback(body.result);
        } else {
            if (transferFunc === 'transfer') {
                console.log("Payment made out to multiple people, total fee: " + global.support.coinToDecimal(body.result.fee) + " XMR");
            }
            let intCount = 0;
            paymentDetails.destinations.forEach(function (details) {
                console.log("Payment made to: " + details.address + " For: " + global.support.coinToDecimal(details.amount) + " XMR");
                intCount += 1;
                if (intCount === paymentDetails.destinations.length) {
                    return callback(body.result);
                }
            });
        }
    });
}, 1);

paymentQueue.drain = function(){
    extraPaymentRound = false;
    if (global.config.payout.timer > 35791){
        console.error("Payout timer is too high.  Please use a value under 35791 to avoid overflows.");
    } else {
        paymentTimer = setInterval(makePayments, global.config.payout.timer * 60 * 1000);
    }
    global.database.setCache('lastPaymentCycle', Math.floor(Date.now()/1000));
};

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
            fee: global.config.payout.fee,
            unlock_time: global.config.payout.unlock_time,
            mixin: global.config.payout.mixIn,
            payment_id: this.paymentID
        };
        let identifier = this.id;
        let amount = this.amount;
        let address = this.address;
        let paymentID = this.paymentID;
        let payee = this;
        debug("Payment Details: " + JSON.stringify(paymentDetails));
        paymentQueue.push(paymentDetails, function (body) {
            if (typeof body.tx_hash !== 'undefined') {
                debug("Successful payment sent to: " + identifier);
                global.mysql.query("INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [0, address, paymentID, amount, body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, global.config.payout.fee, 1]).then(function (result) {
                    payee.transactionID = result.insertId;
                    payee.trackPayment();
                });
            } else {
                console.error("Unknown error from the wallet.");
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
            fee: global.config.payout.fee,
            unlock_time: global.config.payout.unlock_time,
            mixin: global.config.payout.mixIn
        };
        let identifier = this.id;
        let amount = this.amount;
        let address = this.address;
        let payee = this;

        debug("Payment Details: " + JSON.stringify(paymentDetails));
        paymentQueue.push(paymentDetails, function (body) {
            if (typeof body.tx_hash !== 'undefined') {
                debug("Successful payment sent to: " + identifier);
                global.mysql.query("INSERT INTO transactions (bitcoin, address, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [0, address, amount, body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, global.config.payout.fee, 1]).then(function (result) {
                    payee.transactionID = result.insertId;
                    payee.trackPayment();
                });
            } else {
                console.error("Unknown error from the wallet.");
            }
        });
    };

    this.trackPayment = function () {
        global.mysql.query("UPDATE balance SET amount = amount - ? WHERE id = ?", [this.amount, this.sqlID]);
        global.mysql.query("INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, bitcoin, amount, payment_id, transfer_fee)" +
            " VALUES (now(), now(), ?, ?, ?, ?, ?, ?, ?)", [this.poolType, this.address, this.transactionID, this.bitcoin, this.amount - this.fee, this.paymentID, this.fee]);
    };
}

function makePayments() {
    global.mysql.query("SELECT * FROM balance WHERE amount >= ?", [global.support.decimalToCoin(global.config.payout.walletMin)]).then(function (rows) {
        console.log("Loaded all payees into the system for processing");
        let paymentDestinations = [];
        let totalAmount = 0;
        let roundCount = 0;
        let payeeList = [];
        let payeeObjects = {};
        rows.forEach(function (row) {
            debug("Starting round for: " + JSON.stringify(row));
            let payee = new Payee(row.amount, row.payment_address, row.payment_id, row.bitcoin);
            payeeObjects[row.payment_address] = payee;
            global.mysql.query("SELECT payout_threshold FROM users WHERE username = ?", [payee.id]).then(function (userRow) {
                roundCount += 1;
                let threshold = 0;
                if (userRow.length !== 0) {
                    threshold = userRow[0].payout_threshold;
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
                    } else if ((payee.amount >= global.support.decimalToCoin(global.config.payout.exchangeMin) || (payee.amount > threshold && threshold !== 0)) && payee.bitcoin === 0) {
                        debug("Adding " + payee.id + " to the list of people to pay (Payment ID Address).  Payee balance: " + global.support.coinToDecimal(payee.amount));
                        payee.makePaymentWithID();
                    }
                }
                debug("Went: " + roundCount + " With: " + paymentDestinations.length + " Possible destinations and: " + rows.length + " Rows");
                if (roundCount === rows.length && paymentDestinations.length > 0) {
                    while (paymentDestinations.length > 0) {
                        let paymentDetails = {
                            destinations: paymentDestinations.splice(0, global.config.payout.maxPaymentTxns),
                            mixin: global.config.payout.mixIn,
                            fee: global.config.payout.fee,
                            unlock_time: global.config.payout.unlock_time
                        };
                        console.log("Paying out: " + paymentDetails.destinations.length + " people");
                        paymentQueue.push(paymentDetails, function (body) {  //jshint ignore:line
                            // This is the only section that could potentially contain multiple txns.  Lets do this safely eh?
                            if (typeof body.tx_hash !== 'undefined') {
                                debug("Made it to the SQL insert for transactions");
                                let totalAmount = 0;
                                paymentDetails.destinations.forEach(function (payeeItem) {
                                    totalAmount += payeeObjects[payeeItem.address].amount;
                                    totalAmount += payeeObjects[payeeItem.address].fee;
                                });
                                global.mysql.query("INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                    [0, null, null, totalAmount, body.tx_hash.match(hexChars)[0], global.config.payout.mixIn, global.config.payout.fee, paymentDetails.destinations.length]).then(function (result) {
                                    paymentDetails.destinations.forEach(function (payeeItem) {
                                        payee = payeeObjects[payeeItem.address];
                                        payee.transactionID = result.insertId;
                                        payee.trackPayment();
                                    });
                                });
                            } else {
                                console.error("Unknown error from the wallet.");
                            }
                        });
                    }
                }
            });
        });
    });
}

function init() {
    global.support.rpcWallet("store", [], function () {
    });
    setInterval(function () {
        global.support.rpcWallet("store", [], function () {
        });
    }, 60000);
    console.log("Setting the payment timer to: " + global.config.payout.timer + " minutes with a: " + global.config.payout.timerRetry + " minute delay if the wallet is out of money");
    makePayments();
}

init();
