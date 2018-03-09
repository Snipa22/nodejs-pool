"use strict";
const CircularBuffer = require('circular-buffer');
const request = require('request');
const requestJson = require('request-json');
const moment = require('moment');
const debug = require('debug')('support');
const fs = require('fs');
const sprintf = require("sprintf-js").sprintf;

function circularBuffer(size) {
    let buffer = CircularBuffer(size);

    buffer.sum = function () {
        if (this.size() === 0) {
            return 1;
        }
        return this.toarray().reduce(function (a, b) {
            return a + b;
        });
    };

    buffer.average = function (lastShareTime) {
        if (this.size() === 0) {
            return global.config.pool.targetTime * 1.5;
        }
        let extra_entry = (Date.now() / 1000) - lastShareTime;
        return (this.sum() + Math.round(extra_entry)) / (this.size() + 1);
    };

    buffer.clear = function () {
        let i = this.size();
        while (i > 0) {
            this.deq();
            i = this.size();
        }
    };

    return buffer;
}

// accumulates email notifications up to one hour (email/subject -> body)
let emailAcc = {};
// last send time of email (email/subject -> time)
let emailLastSendTime = {};
let lastEmailSendTime;

function sendEmailReal(toAddress, subject, email_body){
    if (lastEmailSendTime && Date.now() - lastEmailSendTime < 1000) {
      setTimeout(sendEmailReal, 1000, toAddress, subject, email_body);
      return;
    }
    lastEmailSendTime = Date.now();
    request.post(global.config.general.mailgunURL + "/messages", {
        auth: {
            user: 'api',
            pass: global.config.general.mailgunKey
        },
        form: {
            from: global.config.general.emailFrom,
            to: toAddress,
            subject: subject,
            text: email_body
        },
        agentOptions: {
            rejectUnauthorized: global.config.general.mailgunNoCert === true ? false : true
        }
    }, function(err, response, body){
        if (!err && response.statusCode === 200) {
            debug(email_body);
            console.log("Email to '" + toAddress + "' was sent successfully!  Response: " + body);
        } else {
            console.error("Did not send e-mail to '" + toAddress + "' successfully!  Response: " + body + " Response: "+JSON.stringify(response));
        }
    });
}

function sendEmail(toAddress, subject, body, wallet){
    if (toAddress === global.config.general.adminEmail && subject.indexOf("FYI") === -1) {
        sendEmailReal(toAddress, subject, body);
    } else {
        let reEmail = /^([a-zA-Z0-9_\.-])+@(([a-zA-Z0-9-])+\.)+([a-zA-Z0-9]{2,4})+$/;
        if (!reEmail.test(toAddress)) {
            debug("Avoid sending email to invalid address '" + toAddress + "'");
            return;
        }
        let key = toAddress + "\t" + subject;
        if (!(key in emailAcc)) {
            emailAcc[key] = body;
            let time_now = Date.now();
            let is_fast_email = !(key in emailLastSendTime) || time_now - emailLastSendTime[key] > 6*60*60*1000;
            emailLastSendTime[key] = time_now;
            setTimeout(function(email_address, email_subject, wallet) {
                let key2 = email_address + "\t" + email_subject;
                let email_body = emailAcc[key2];
                delete emailAcc[key2];
                let emailData = {
                    wallet: wallet
                };
                sendEmailReal(email_address, email_subject, "Hello,\n\n" + email_body + "\n\nThank you,\n" + sprintf(global.config.general.emailSig, emailData));
            }, (is_fast_email ? 5 : 30)*60*1000, toAddress, subject, wallet);
        } else {
            emailAcc[key] += body;
        }
    }
}

function jsonRequest(host, port, data, is_wallet, callback, path) {
    path = path || 'json_rpc';
    let uri;
    if (global.config.rpc.https) {
        uri = "https://" + host + ":" + port + "/";
    } else {
        uri = "http://" + host + ":" + port + "/";
    }
    debug("JSON URI: " + uri + path + " Args: " + JSON.stringify(data));
    let client = requestJson.createClient(uri, {timeout: 5*60*1000});
    client.headers["Content-Type"] = "application/json";
    client.headers["Content-Length"] = data.length;
    client.headers["Accept"] = "application/json";
    if (is_wallet && global.config.payout.rpcPasswordEnabled && global.config.payout.rpcPasswordPath){
        fs.readFile(port === global.config.daemon.port ? global.config.payout.rpcPasswordPath : global.config.payout["rpcPasswordPath" + port.toString()], 'utf8', function(err, data){
            if (err){
                console.error("RPC password enabled, unable to read the file due to: " + JSON.stringify(err));
                return;
            }
            let passData = data.split(":");
            client.setBasicAuth(passData[0], passData[1]);
            request.post(uri, {
                auth:{
                    user: passData[0],
                    pass: passData[1],
                    sendImmediately: false
                },
                data: JSON.stringify(data)
            }, function (err, res, body) {
                if (err) {
                    return callback(err);
                }
                debug("JSON result: " + JSON.stringify(body));
                return callback(body);
            });
        });
    } else {
        client.post(path, data, function (err, res, body) {
            if (err) {
                return callback(err);
            }
            debug("JSON result: " + JSON.stringify(body));
            return callback(body);
        });
    }
}

function rpc(host, port, method, params, callback) {

    let data = {
        id: "0",
        jsonrpc: "2.0",
        method: method,
        params: params
    };
    return jsonRequest(host, port, data, false, callback);
}

function rpc_wallet(host, port, method, params, callback) {

    let data = {
        id: "0",
        jsonrpc: "2.0",
        method: method,
        params: params
    };
    return jsonRequest(host, port, data, true, callback);
}

function getActivePort(callback) {
    global.mysql.query("SELECT item_value FROM pool.config WHERE module = 'daemon' and item = 'activePort'").then(function (rows) {
        if (rows.length != 1) {
	    console.error("Can't get pool.config.daemon.activePort value");
            return callback(null);
        }
        callback(parseInt(rows[0].item_value));
    });
}

function setActivePort(activePort) {
    global.mysql.query("UPDATE config SET item_value = ? WHERE module = 'daemon' and item = 'activePort'", [activePort]);
}

function formatDate(date) {
    // Date formatting for MySQL date time fields.
    return moment(date).format('YYYY-MM-DD HH:mm:ss');
}

function formatDateFromSQL(date) {
    // Date formatting for MySQL date time fields.
    let ts = new Date(date);
    return Math.floor(ts.getTime() / 1000);
}

function coinToDecimal(amount) {
    return amount / global.config.coin.sigDigits;
}

function decimalToCoin(amount) {
    return Math.round(amount * global.config.coin.sigDigits);
}

function bitcoinDecimalToCoin(amount) {
    return Math.round(amount * 100000000);
}

function bitcoinCoinToDecimal(amount) {
    return amount / 100000000;
}

function blockCompare(a, b) {
    if (a.height < b.height) {
        return 1;
    }

    if (a.height > b.height) {
        return -1;
    }
    return 0;
}

function tsCompare(a, b) {
    if (a.ts < b.ts) {
        return 1;
    }

    if (a.ts > b.ts) {
        return -1;
    }
    return 0;
}

module.exports = function () {
    return {
        rpcDaemon: function (method, params, callback) {
            rpc(global.config.daemon.address, global.config.daemon.port, method, params, callback);
        },
        rpcPortDaemon: function (port, method, params, callback) {
            rpc(global.config.daemon.address, port, method, params, callback);
        },
        rpcWallet: function (method, params, callback) {
            rpc_wallet(global.config.wallet.address, global.config.wallet.port, method, params, callback);
        },
        rpcPortWallet: function (port, method, params, callback) {
            rpc_wallet(global.config.wallet.address, port, method, params, callback);
        },
        jsonRequest: jsonRequest,
        circularBuffer: circularBuffer,
        formatDate: formatDate,
        coinToDecimal: coinToDecimal,
        decimalToCoin: decimalToCoin,
        bitcoinDecimalToCoin: bitcoinDecimalToCoin,
        bitcoinCoinToDecimal: bitcoinCoinToDecimal,
        formatDateFromSQL: formatDateFromSQL,
        blockCompare: blockCompare,
        sendEmail: sendEmail,
        tsCompare: tsCompare,
	getActivePort: getActivePort,
        setActivePort: setActivePort
    };
};
