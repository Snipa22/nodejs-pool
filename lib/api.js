"use strict";
const express = require('express');        // call express
const app = express();                 // define our app using express
const cluster = require('cluster');
const async = require("async");
const debug = require("debug")("api");
const btcValidator = require('wallet-address-validator');
const cnUtil = require('cryptonote-util');
let bodyParser = require('body-parser');
let jwt = require('jsonwebtoken'); // used to create, sign, and verify tokens
const crypto = require('crypto');


let addressBase58Prefix = cnUtil.address_decode(new Buffer(global.config.pool.address));
let threadName = "";
let workerList = [];

if (cluster.isMaster) {
    threadName = "(Master) ";
} else {
    threadName = "(Worker " + cluster.worker.id + " - " + process.pid + ") ";
}

app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

// ROUTES FOR OUR API
// =============================================================================

// test route to make sure everything is working (accessed at GET http://localhost:8080/api)

// Config API
app.get('/config', function (req, res) {
    res.json({
        pplns_fee: global.config.payout.pplnsFee,
        pps_fee: global.config.payout.ppsFee,
        solo_fee: global.config.payout.soloFee,
        btc_fee: global.config.payout.btcFee,
        min_wallet_payout: global.config.payout.walletMin * global.config.general.sigDivisor,
        min_btc_payout: global.config.payout.exchangeMin * global.config.general.sigDivisor,
        min_exchange_payout: global.config.payout.exchangeMin * global.config.general.sigDivisor,
        dev_donation: global.config.payout.devDonation * global.config.general.sigDivisor,
        pool_dev_donation: global.config.payout.poolDevDonation * global.config.general.sigDivisor,
        maturity_depth: global.config.payout.blocksRequired,
        min_denom: global.config.payout.denom * global.config.general.sigDivisor
    });
});

// Pool APIs
app.get('/pool/address_type/:address', function (req, res) {
    let address = req.params.address;
    if (addressBase58Prefix === cnUtil.address_decode(new Buffer(address))) {
        res.json({valid: true, address_type: 'XMR'});
    } else if (btcValidator.validate(this.address) && global.config.general.allowBitcoin) {
        res.json({valid: true, address_type: 'BTC'});
    } else {
        res.json({valid: false});
    }
});

app.get('/pool/stats', function (req, res) {
    let localCache = global.database.getCache('pool_stats_global');
    delete(localCache.minerHistory);
    delete(localCache.hashHistory);
    res.json({pool_list: ['pplns', 'pps', 'solo'], pool_statistics: localCache});
});

app.get('/pool/chart/hashrate', function (req, res) {
    res.json(global.database.getCache('global_stats')['hashHistory']);
});

app.get('/pool/chart/miners', function (req, res) {
    res.json(global.database.getCache('global_stats')['minerHistory']);
});

app.get('/pool/chart/hashrate/:pool_type', function (req, res) {
    let pool_type = req.params.pool_type;
    let localCache;
    switch (pool_type) {
        case 'pplns':
            localCache = global.database.getCache('pplns_stats');
            break;
        case 'pps':
            localCache = global.database.getCache('pps_stats');
            break;
        case 'solo':
            localCache = global.database.getCache('solo_stats');
            break;
        case 'default':
            return res.json({'error': 'Invalid pool type'});
    }
    res.json(localCache['hashHistory']);
});

app.get('/pool/chart/miners/:pool_type', function (req, res) {
    let pool_type = req.params.pool_type;
    let localCache;
    switch (pool_type) {
        case 'pplns':
            localCache = global.database.getCache('stats_pplns');
            break;
        case 'pps':
            localCache = global.database.getCache('stats_pps');
            break;
        case 'solo':
            localCache = global.database.getCache('stats_solo');
            break;
        case 'default':
            return res.json({'error': 'Invalid pool type'});
    }
    res.json(localCache['minerHistory']);
});

app.get('/pool/stats/:pool_type', function (req, res) {
    let pool_type = req.params.pool_type;
    let localCache;
    switch (pool_type) {
        case 'pplns':
            localCache = global.database.getCache('pool_stats_pplns');
            localCache.fee = global.config.payout.pplnsFee;
            break;
        case 'pps':
            localCache = global.database.getCache('pool_stats_pps');
            localCache.fee = global.config.payout.ppsFee;
            break;
        case 'solo':
            localCache = global.database.getCache('pool_stats_solo');
            localCache.fee = global.config.payout.soloFee;
            break;
        case 'default':
            return res.json({'error': 'Invalid pool type'});
    }
    delete(localCache.minerHistory);
    delete(localCache.hashHistory);
    res.json({pool_statistics: localCache});
});

app.get('/pool/ports', function (req, res) {
    res.json(global.database.getCache('poolPorts'));
});

app.get('/pool/blocks/:pool_type', function (req, res) {
    res.json(global.database.getBlockList(req.params.pool_type));
});

app.get('/pool/blocks', function (req, res) {
    res.json(global.database.getBlockList());
});

app.get('/pool/payments/:pool_type', function (req, res) {
    let pool_type = req.params.pool_type;
    switch (pool_type) {
        case 'pplns':
            break;
        case 'pps':
            break;
        case 'solo':
            break;
        case 'default':
            return res.json({'error': 'Invalid pool type'});
    }
    let paymentIds = [];
    let query = "SELECT distinct(transaction_id) as txnID FROM payments WHERE pool_type = ? ORDER BY transaction_id";
    let response = [];
    global.mysql.query(query, [pool_type]).then(function (rows) {
        if (rows.length === 0) {
            return res.json([]);
        }
        rows.forEach(function (row, index, array) {
            paymentIds.push(row.txnID);
            if (array.length === paymentIds.length) {
                global.mysql.query("SELECT * FROM transactions WHERE id IN (" + paymentIds.join() + ") ORDER BY id DESC").then(function (txnIDRows) {
                    txnIDRows.forEach(function (txnrow) {
                        let ts = new Date(txnrow.submitted_time);
                        response.push({
                            id: txnrow.id,
                            hash: txnrow.transaction_hash,
                            mixins: txnrow.mixin,
                            payees: txnrow.payees,
                            fee: txnrow.fees,
                            value: txnrow.xmr_amt,
                            ts: ts.getTime(),
                        });
                        if (response.length === txnIDRows.length) {
                            return res.json(response.sort(global.support.tsCompare));
                        }
                    });
                });
            }
        });
    }).catch(function (err) {
        console.error(threadName + "Error getting pool payments: " + JSON.stringify(err));
        return res.json({error: 'Issue getting pool payments'});
    });
});

app.get('/pool/payments', function (req, res) {
    let query = "SELECT * FROM transactions ORDER BY id DESC";
    global.mysql.query(query).then(function (rows) {
        if (rows.length === 0) {
            return res.json([]);
        }
        let response = [];
        rows.forEach(function (row, index, array) {
            global.mysql.query("SELECT pool_type FROM payments WHERE transaction_id = ? LIMIT 1", [row.id]).then(function (ptRows) {
                let ts = new Date(row.submitted_time);
                response.push({
                    id: row.id,
                    hash: row.transaction_hash,
                    mixins: row.mixin,
                    payees: row.payees,
                    fee: row.fees,
                    value: row.xmr_amt,
                    ts: ts.getTime(),
                    pool_type: ptRows[0].pool_type
                });
                if (array.length === response.length) {
                    res.json(response.sort(global.support.tsCompare));
                }
            });
        });
    }).catch(function (err) {
        console.error(threadName + "Error getting miner payments: " + JSON.stringify(err));
        res.json({error: 'Issue getting miner payments'});
    });
});

// Network APIs
app.get('/network/stats', function (req, res) {
    res.json(global.database.getCache('networkBlockInfo'));
});

// Miner APIs
app.get('/miner/:address/identifiers', function (req, res) {
    let address = req.params.address;
    return res.json(global.database.getCache(address + '_identifiers'));
});

app.get('/miner/:address/payments', function (req, res) {
    let address_parts = req.params.address.split('.');
    let address = address_parts[0];
    let payment_id = address_parts[1];
    let query = "SELECT amount, pool_type, transaction_id, UNIX_TIMESTAMP(paid_time) as ts FROM " +
        "payments WHERE payment_address = ? AND paid_time < ? AND payment_id = ? ORDER BY paid_time DESC LIMIT 25";
    if (typeof(payment_id) === 'undefined') {
        query = "SELECT amount as amt, pool_type, transaction_id, UNIX_TIMESTAMP(paid_time) as ts FROM " +
            "payments WHERE payment_address = ? AND paid_time < ? AND payment_id IS ? ORDER BY paid_time DESC LIMIT 25";
    }
    let start = req.query.start || Date.now() / 1000;
    start *= 1000;
    let response = [];
    global.mysql.query(query, [address, global.support.formatDate(start), payment_id]).then(function (rows) {
        if (rows.length === 0) {
            return res.json(response);
        }
        rows.forEach(function (row, index, array) {
            debug(threadName + "Got rows from initial SQL query: " + JSON.stringify(row));
            global.mysql.query("SELECT transaction_hash, mixin FROM transactions WHERE id = ? ORDER BY id DESC", [row.transaction_id]).then(function (txnrows) {
                txnrows.forEach(function (txnrow) {
                    debug(threadName + "Got a row that's a transaction ID: " + JSON.stringify(txnrow));
                    response.push({
                        pt: row.pool_type,
                        ts: Math.ceil(row.ts),
                        amount: row.amt,
                        txnHash: txnrow.transaction_hash,
                        mixin: txnrow.mixin
                    });
                    if (array.length === response.length) {
                        return res.json(response);
                    }
                });
            });
        });
    }).catch(function (err) {
        console.error(threadName + "Error getting miner payments: " + JSON.stringify(err));
        return res.json({error: 'Issue getting miner payments'});
    });
});

app.get('/miner/:address/stats/allWorkers', function (req, res) {
    let address = req.params.address;
    let identifiers = global.database.getCache(address + '_identifiers').sort();
    let globalCache = global.database.getCache(address);
    let returnData = {global: {
        lts: Math.floor(globalCache.lastHash / 1000),
        identifer: 'global',
        hash: globalCache.hash,
        totalHash: globalCache.totalHashes
    }};
    let intCounter = 0;
    identifiers.forEach(function(identifier){
        let cachedData = global.database.getCache(req.params.address+"_"+identifier);
        returnData[identifier] = {
            lts: Math.floor(cachedData.lastHash / 1000),
            identifer: identifier,
            hash: cachedData.hash,
            totalHash: cachedData.totalHashes
        };
        intCounter += 1;
        if (intCounter === identifiers.length){
            return res.json(returnData);
        }
    });
});

app.get('/miner/:address/stats/:identifier', function (req, res) {
    let address = req.params.address;
    let identifier = req.params.identifier;
    let memcKey = address + "_" + identifier;
    /*
     hash: Math.floor(localStats.miners[miner] / 600),
     totalHashes: 0,
     lastHash: localTimes.miners[miner]
     */
    let cachedData = global.database.getCache(memcKey);
    return res.json({
        lts: Math.floor(cachedData.lastHash / 1000),
        identifer: identifier,
        hash: cachedData.hash,
        totalHash: cachedData.totalHashes
    });
});

app.get('/miner/:address/chart/hashrate', function (req, res) {
    return res.json(global.database.getCache(req.params.address)['hashHistory']);
});

app.get('/miner/:address/chart/hashrate/allWorkers', function (req, res) {
    let address = req.params.address;
    let identifiers = global.database.getCache(address + '_identifiers').sort();
    let returnData = {global: global.database.getCache(req.params.address)['hashHistory']};
    let intCounter = 0;
    identifiers.forEach(function(identifier){
        returnData[identifier] = global.database.getCache(req.params.address+"_"+identifier)['hashHistory'];
        intCounter += 1;
        if (intCounter === identifiers.length){
            return res.json(returnData);
        }
    });
});

app.get('/miner/:address/chart/hashrate/:identifier', function (req, res) {
    return res.json(global.database.getCache(req.params.address + "_" + req.params.identifier)['hashHistory']);
});

app.get('/miner/:address/stats', function (req, res) {
    let address = req.params.address;
    let address_parts = req.params.address.split('.');
    let address_pt = address_parts[0];
    let payment_id = address_parts[1];
    let paidQuery = "SELECT SUM(amount) as amt FROM payments WHERE payment_address = ? AND payment_id = ?";
    let unpaidQuery = "SELECT SUM(amount) as amt FROM balance WHERE payment_address = ? AND payment_id = ?";
    if (typeof(payment_id) === 'undefined') {
        paidQuery = "SELECT SUM(amount) as amt FROM payments WHERE payment_address = ? AND payment_id IS ?";
        unpaidQuery = "SELECT SUM(amount) as amt FROM balance WHERE payment_address = ? AND payment_id IS ?";
    }
    async.waterfall([
        function (callback) {
            debug(threadName + "Checking Influx for last 10min avg for /miner/address/stats");
            return callback(null, {hash: global.database.getCache(address).hash, identifier: 'global'});
        },
        function (returnData, callback) {
            // TODO: Fixme once we have total hash counts...
            returnData.totalHashes = global.database.getCache(address).totalHashes;
            return callback(null, returnData);
        },
        function (returnData, callback) {
            debug(threadName + "Checking Influx for last share for /miner/address/stats");
            returnData.lastHash = Math.floor(global.database.getCache(address).lastHash / 1000);
            return callback(null, returnData);
        },
        function (returnData, callback) {
            debug(threadName + "Checking MySQL total amount paid for /miner/address/stats");
            global.mysql.query(paidQuery, [address_pt, payment_id]).then(function (rows) {
                if (typeof(rows[0]) === 'undefined') {
                    returnData.amtPaid = 0;
                } else {
                    returnData.amtPaid = rows[0].amt;
                    if (returnData.amtPaid === null) {
                        returnData.amtPaid = 0;
                    }
                }
                return callback(null, returnData);
            });
        },
        function (returnData, callback) {
            debug(threadName + "Checking MySQL total amount unpaid for /miner/address/stats");
            global.mysql.query(unpaidQuery, [address_pt, payment_id]).then(function (rows) {
                if (typeof(rows[0]) === 'undefined') {
                    returnData.amtDue = 0;
                } else {
                    returnData.amtDue = rows[0].amt;
                    if (returnData.amtDue === null) {
                        returnData.amtDue = 0;
                    }
                }
                return callback(true, returnData);
            });
        }
    ], function (err, result) {
        debug(threadName + "Result information for " + address + ": " + JSON.stringify(result));
        if (err === true) {
            return res.json(result);
        }
        if (err) {
            console.error(threadName + "Error within the miner stats identifier func");
            return res.json({'error': err.toString()});
        }
    });
});

// Authentication
app.post('/authenticate', function (req, res) {
    let hmac = crypto.createHmac('sha256', global.config.api.secKey).update(req.body.password).digest('hex');
    global.mysql.query("SELECT * FROM users WHERE username = ? AND ((pass IS null AND email = ?) OR (pass = ?))", [req.body.username, req.body.password, hmac]).then(function (rows) {
        if (rows.length === 0) {
            return res.json({'success': false, msg: 'Invalid username/password'});
        }
        let token = jwt.sign({id: rows[0].id, admin: rows[0].admin}, global.config.api.secKey, {expiresIn: '1d'});
        return res.json({'success': true, 'msg': token});
    });
});

// JWT Verification
// get an instance of the router for api routes
let secureRoutes = express.Router();
let adminRoutes = express.Router();

// route middleware to verify a token
secureRoutes.use(function (req, res, next) {
    let token = req.body.token || req.query.token || req.headers['x-access-token'];
    if (token) {
        jwt.verify(token, global.config.api.secKey, function (err, decoded) {
            if (err) {
                return res.json({success: false, msg: 'Failed to authenticate token.'});
            } else {
                req.decoded = decoded;
                next();
            }
        });

    } else {
        return res.status(403).send({
            success: false,
            msg: 'No token provided.'
        });
    }
});

// Secure/logged in routes.

secureRoutes.get('/tokenRefresh', function (req, res) {
    let token = jwt.sign({id: req.decoded.id, admin: req.decoded.admin}, global.config.api.secKey, {expiresIn: '1d'});
    return res.json({'msg': token});
});

secureRoutes.get('/', function (req, res) {
    global.mysql.query("SELECT payout_threshold FROM users WHERE id = ?", [req.decoded.id]).then(function(row){
        return res.json({msg: row[0].payout_threshold});
    });
    return res.json({msg: 0});
});

secureRoutes.post('/changePassword', function (req, res) {
    let hmac = crypto.createHmac('sha256', global.config.api.secKey).update(req.body.password).digest('hex');
    global.mysql.query("UPDATE users SET pass = ? WHERE id = ?", [hmac, req.decoded.id]).then(function () {
        return res.json({'msg': 'Password updated'});
    });
});

secureRoutes.post('/changePayoutThreshold', function (req, res) {
    let threshold = req.body.threshold;
    if (threshold < global.config.payout.walletMin) {
        threshold = global.config.payout.walletMin;
    }
    threshold = global.support.decimalToCoin(threshold);
    global.mysql.query("UPDATE users SET payout_threshold = ? WHERE id = ?", [threshold, req.decoded.id]).then(function () {
        return res.json({'msg': 'Threshold updated, set to: ' + global.config.support.coinToDecimal(threshold)});
    });
});

// Administrative routes/APIs

adminRoutes.use(function (req, res, next) {
    let token = req.body.token || req.query.token || req.headers['x-access-token'];
    if (token) {
        jwt.verify(token, global.config.api.secKey, function (err, decoded) {
            if (decoded.admin !== 1) {
                return res.status(403).send({
                    success: false,
                    msg: 'You are not an admin.'
                });
            }
            if (err) {
                return res.json({success: false, msg: 'Failed to authenticate token.'});
            } else {
                req.decoded = decoded;
                next();
            }
        });

    } else {
        return res.status(403).send({
            success: false,
            msg: 'No token provided.'
        });
    }
});

adminRoutes.get('/stats', function (req, res) {
    /*
     Admin interface stats.
     For each pool type + global, we need the following:
     Total Owed, Total Paid, Total Mined, Total Blocks, Average Luck
     */
    let intCache = {
        'pplns': {owed: 0, paid: 0, mined: 0, shares: 0, targetShares: 0},
        'pps': {owed: 0, paid: 0, mined: 0, shares: 0, targetShares: 0},
        'solo': {owed: 0, paid: 0, mined: 0, shares: 0, targetShares: 0},
        'global': {owed: 0, paid: 0, mined: 0, shares: 0, targetShares: 0},
        'fees': {owed: 0, paid: 0, mined: 0, shares: 0, targetShares: 0}
    };
    async.series([
        function (callback) {
            global.mysql.query("select * from balance").then(function (rows) {
                rows.forEach(function (row) {
                    intCache[row.pool_type].owed += row.amount;
                    intCache.global.owed += row.amount;
                });
            }).then(function () {
                return callback(null);
            });
        },
        function (callback) {
            global.mysql.query("select * from payments").then(function (rows) {
                rows.forEach(function (row) {
                    intCache[row.pool_type].paid += row.amount;
                    intCache.global.paid += row.amount;
                });
            }).then(function () {
                return callback(null);
            });
        },
        function (callback) {
            global.database.getBlockList().forEach(function (block) {
                intCache[block.pool_type].mined += block.value;
                intCache.global.mined += block.value;
                intCache[block.pool_type].shares += block.shares;
                intCache.global.shares += block.shares;
                intCache[block.pool_type].targetShares += block.diff;
                intCache.global.targetShares += block.diff;
            });
            return callback(null);
        }
    ], function (err) {
        return res.json(intCache);
    });
});

adminRoutes.get('/wallet', function (req, res) {
    // Stats for the admin interface.
    // Load the wallet state from cache, NOTHING HAS DIRECT ACCESS.
    // walletStateInfo
    return res.json(global.database.getCache('walletStateInfo'));
});

adminRoutes.get('/wallet/history', function (req, res) {
    // walletHistory
    if (req.decoded.admin === 1) {
        return res.json(global.database.getCache('walletHistory'));
    }
});

adminRoutes.get('/ports', function (req, res) {
    let retVal = [];
    global.mysql.query("SELECT * FROM port_config").then(function (rows) {
        rows.forEach(function (row) {
            retVal.push({
                port: row.poolPort,
                diff: row.difficulty,
                desc: row.portDesc,
                portType: row.portType,
                hidden: row.hidden === 1,
                ssl: row.ssl === 1
            });
        });
    }).then(function () {
        return res.json(retVal);
    });
});

adminRoutes.post('/ports', function (req, res) {
    global.mysql.query("SELECT * FROM port_config WHERE poolPort = ?", [req.decoded.port]).then(function (rows) {
        if (rows.length !== 0) {
            return "Port already exists with that port number.";
        }
        if (req.decoded.diff > global.config.pool.maxDifficulty || req.decoded.diff < global.config.pool.minDifficulty) {
            return "Invalid difficulty.";
        }
        if (["pplns", "solo", "pps"].indexOf(req.decoded.portType) === -1) {
            return "Invalid port type";
        }
        global.mysql.query("INSERT INTO port_config (poolPort, difficulty, portDesc, portType, hidden, ssl) VALUES (?, ?, ?, ?, ?, ?)",
            [req.decoded.port, req.decoded.diff, req.decoded.desc, req.decoded.portType, req.decoded.hidden === 1, req.decoded.ssl === 1]);
    }).then(function (err) {
        if (typeof(err) === 'string') {
            return res.json({success: false, msg: err});
        }
        return res.json({success: true, msg: "Added port to database"});
    });
});

adminRoutes.put('/ports', function (req, res) {
    let portNumber = Number(req.decoded.portNum);
    global.mysql.query("SELECT * FROM port_config WHERE poolPort = ?", [portNumber]).then(function (rows) {
        if (rows.length === 0) {
            return "Port doesn't exist in the database";
        }
        if (req.decoded.diff > global.config.pool.maxDifficulty || req.decoded.diff < global.config.pool.minDifficulty) {
            return "Invalid difficulty.";
        }
        if (["pplns", "solo", "pps"].indexOf(req.decoded.portType) === -1) {
            return "Invalid port type";
        }
        global.mysql.query("UPDATE port_config SET difficulty=?, portDesc=?, portType=?, hidden=?, ssl=? WHERE poolPort = ?",
            [req.decoded.diff, req.decoded.desc, req.decoded.portType, req.decoded.hidden === 1, req.decoded.ssl === 1, portNumber]);
    }).then(function (err) {
        if (typeof(err) === 'string') {
            return res.json({success: false, msg: err});
        }
        return res.json({success: true, msg: "Updated port in database"});
    });
});

adminRoutes.delete('/ports', function (req, res) {
    let portNumber = Number(req.decoded.portNum);
    global.mysql.query("SELECT * FROM port_config WHERE poolPort = ?", [portNumber]).then(function (rows) {
        if (rows.length === 0) {
            return "Port doesn't exist in the database";
        }
        global.mysql.query("DELETE FROM port_config WHERE poolPort = ?", [portNumber]);
    }).then(function (err) {
        if (typeof(err) === 'string') {
            return res.json({success: false, msg: err});
        }
        return res.json({success: true, msg: "Added port to database"});
    });
});

adminRoutes.get('/config', function (req, res) {
    let retVal = [];
    global.mysql.query("SELECT * FROM config").then(function (rows) {
        rows.forEach(function (row) {
            retVal.push({
                id: row.id,
                module: row.module,
                item: row.item,
                value: row.item_value,
                type: row.item_type,
                desc: row.item_desc
            });
        });
    }).then(function () {
        return res.json(retVal);
    });
});

adminRoutes.put('/config', function (req, res) {
    let configID = Number(req.decoded.id);
    global.mysql.query("SELECT * FROM config WHERE id = ?", [configID]).then(function (rows) {
        if (rows.length === 0) {
            return "Config item doesn't exist in the database";
        }
        global.mysql.query("UPDATE config SET item_value=? WHERE id = ?", [req.decoded.value, configID]);
    }).then(function (err) {
        if (typeof(err) === 'string') {
            return res.json({success: false, msg: err});
        }
        return res.json({success: true, msg: "Updated port in database"});
    });
});

adminRoutes.get('/userList', function (req, res) {
    /*
     List of all the users in the system.
     Might as well do it all, right? :3
     Data Format to be documented.
     */
    let intCache = {};
    global.mysql.query("select sum(balance.amount) as amt_due, sum(payments.amount) as amt_paid," +
        "balance.payment_address as address, balance.payment_id as payment_id from balance LEFT JOIN payments on " +
        "payments.payment_address=balance.payment_address or payments.payment_id=balance.payment_id " +
        "group by address, payment_id").then(function (rows) {
        rows.forEach(function (row) {
            let key = row.address;
            if (row.payment_id !== null) {
                key += '.' + row.payment_id;
            }
            intCache[key] = {
                paid: row.amt_paid,
                due: row.amt_due,
                address: key,
                workers: [],
                lastHash: 0,
                totalHashes: 0,
                hashRate: 0,
                goodShares: 0,
                badShares: 0
            };
        });
    }).then(function () {
        let minerList = global.database.getCache('minerList');
        if (minerList) {
            minerList.forEach(function (miner) {
                let minerData = miner.split('_');
                let minerCache = global.database.getCache(miner);
                if (!minerCache.hasOwnProperty('goodShares')) {
                    minerCache.goodShares = 0;
                    minerCache.badShares = 0;
                }
                if (!intCache.hasOwnProperty(minerData[0])) {
                    intCache[minerData[0]] = {paid: 0, due: 0, address: minerData[0], workers: []};
                }
                if (typeof(minerData[1]) !== 'undefined') {
                    intCache[minerData[0]].workers.push({
                        worker: minerData[1],
                        hashRate: minerCache.hash,
                        lastHash: minerCache.lastHash,
                        totalHashes: minerCache.totalHashes,
                        goodShares: minerCache.goodShares,
                        badShares: minerCache.badShares
                    });
                } else {
                    intCache[minerData[0]].lastHash = minerCache.lastHash;
                    intCache[minerData[0]].totalHashes = minerCache.totalHashes;
                    intCache[minerData[0]].hashRate = minerCache.hash;
                    intCache[minerData[0]].goodShares = minerCache.goodShares;
                    intCache[minerData[0]].badShares = minerCache.badShares;
                }
            });
            let retList = [];
            for (let minerId in intCache) {
                if (intCache.hasOwnProperty(minerId)) {
                    let miner = intCache[minerId];
                    retList.push(miner);
                }
            }
            return res.json(retList);
        }
        return res.json([]);
    });
});

// apply the routes to our application with the prefix /api
app.use('/authed', secureRoutes);
app.use('/admin', adminRoutes);

// Authenticated routes

if (cluster.isMaster) {
    let numWorkers = require('os').cpus().length;
    console.log('Master cluster setting up ' + numWorkers + ' workers...');

    for (let i = 0; i < numWorkers; i++) {
        let worker = cluster.fork();
        workerList.push(worker);
    }

    cluster.on('online', function (worker) {
        console.log('Worker ' + worker.process.pid + ' is online');
    });

    cluster.on('exit', function (worker, code, signal) {
        console.log('Worker ' + worker.process.pid + ' died with code: ' + code + ', and signal: ' + signal);
        console.log('Starting a new worker');
        worker = cluster.fork();
        workerList.push(worker);
    });
} else {
    app.listen(8001, function () {
        console.log('Process ' + process.pid + ' is listening to all incoming requests');
    });
}
