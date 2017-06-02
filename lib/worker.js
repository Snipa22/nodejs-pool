"use strict";
const debug = require("debug")("worker");
const async = require("async");
const sprintf = require("sprintf-js").sprintf;
const zmq = require('zmq');
const sock = zmq.socket('pub');

let threadName = "Worker Server ";
let cycleCount = 0;
sock.bindSync('tcp://127.0.0.1:3000');
let lastBlockHash = null;

function updateShareStats() {
    // This is an omni-worker to deal with all things share-stats related
    // Time based averages are worked out on ring buffers.
    // Buffer lengths?  You guessed it, configured in SQL.
    // Stats timeouts are 30 seconds, so everything for buffers should be there.
    let currentTime = Date.now();
    let activeAddresses = [];
    async.waterfall([
        function (callback) {
            global.coinFuncs.getLastBlockHeader(function (body) {
                callback(null, body.height + 1);
            });
        },
        function (height, callback) {
            let locTime = Date.now() - 600000;
            let identifierTime = Date.now() - 1800000;
            let localStats = {pplns: 0, pps: 0, solo: 0, prop: 0, global: 0, miners: {}};
            let localMinerCount = {pplns: 0, pps: 0, solo: 0, prop: 0, global: 0};
            let localTimes = {
                pplns: locTime, pps: locTime, solo: locTime, prop: locTime,
                global: locTime, miners: {}
            };
            let minerList = [];
            let identifiers = {};
            let loopBreakout = 0;
            async.doUntil(function (callback_until) {
                let oldestTime = Date.now();
                let loopCount = 0;
                let txn = global.database.env.beginTxn({readOnly: true});
                let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
                for (let found = (cursor.goToRange(height) === height); found; found = cursor.goToNextDup()) {
                    cursor.getCurrentBinary(function (key, share) {  // jshint ignore:line
                        try {
                            share = global.protos.Share.decode(share);
                        } catch (e) {
                            console.error(share);
                            return;
                        }
                        if (share.timestamp < oldestTime) {
                            oldestTime = share.timestamp;
                        }
                        if (share.timestamp <= identifierTime) {
                            return;
                        }
                        let minerID = share.paymentAddress;
                        if (typeof(share.paymentID) !== 'undefined' && share.paymentID.length > 10) {
                            minerID = minerID + '.' + share.paymentID;
                        }
                        if (minerID in identifiers && identifiers[minerID].indexOf(share.identifier) >= 0) {
                            loopCount += 1;
                        } else if (minerID in identifiers) {
                            identifiers[minerID].push(share.identifier);
                        } else {
                            identifiers[minerID] = [share.identifier];
                        }
                        if (share.timestamp <= locTime) {
                            return;
                        }
                        let minerIDWithIdentifier = minerID + "_" + share.identifier;
                        localStats.global += share.shares;
                        if (localTimes.global <= share.timestamp) {
                            localTimes.global = share.timestamp;
                        }
                        let minerType;
                        switch (share.poolType) {
                            case global.protos.POOLTYPE.PPLNS:
                                minerType = 'pplns';
                                localStats.pplns += share.shares;
                                if (localTimes.pplns <= share.timestamp) {
                                    localTimes.pplns = share.timestamp;
                                }
                                break;
                            case global.protos.POOLTYPE.PPS:
                                localStats.pps += share.shares;
                                minerType = 'pps';
                                if (localTimes.pps <= share.timestamp) {
                                    localTimes.pps = share.timestamp;
                                }
                                break;
                            case global.protos.POOLTYPE.SOLO:
                                localStats.solo += share.shares;
                                minerType = 'solo';
                                if (localTimes.solo <= share.timestamp) {
                                    localTimes.solo = share.timestamp;
                                }
                                break;
                        }
                        if (minerList.indexOf(minerID) >= 0) {
                            localStats.miners[minerID] += share.shares;
                            if (localTimes.miners[minerID] < share.timestamp) {
                                localTimes.miners[minerID] = share.timestamp;
                            }
                        } else {
                            localMinerCount[minerType] += 1;
                            localMinerCount.global += 1;
                            localStats.miners[minerID] = share.shares;
                            localTimes.miners[minerID] = share.timestamp;
                            minerList.push(minerID);
                        }
                        if (minerList.indexOf(minerIDWithIdentifier) >= 0) {
                            localStats.miners[minerIDWithIdentifier] += share.shares;
                            if (localTimes.miners[minerIDWithIdentifier] < share.timestamp) {
                                localTimes.miners[minerIDWithIdentifier] = share.timestamp;
                            }
                        } else {
                            localStats.miners[minerIDWithIdentifier] = share.shares;
                            localTimes.miners[minerIDWithIdentifier] = share.timestamp;
                            minerList.push(minerIDWithIdentifier);
                        }
                    });
                }
                cursor.close();
                txn.abort();
                return callback_until(null, oldestTime);
            }, function (oldestTime) {
                height -= 1;
                loopBreakout += 1;
                if (loopBreakout > 60) {
                    return true;
                }
                return oldestTime <= identifierTime;
            }, function (err) {
                // todo: Need to finish parsing the cached data into caches for caching purproses.
                let globalMinerList = global.database.getCache('minerList');
                if (globalMinerList === false) {
                    globalMinerList = [];
                }
                let cache_updates = {};
                // pplns: 0, pps: 0, solo: 0, prop: 0, global: 0
                ['pplns', 'pps', 'solo', 'prop', 'global'].forEach(function (key) {
                    let cachedData = global.database.getCache(key + "_stats");
                    if (cachedData !== false) {
                        cachedData.hash = Math.floor(localStats[key] / 600);
                        cachedData.lastHash = localTimes[key];
                        cachedData.minerCount = localMinerCount[key];
                        if (!cachedData.hasOwnProperty("hashHistory")) {
                            cachedData.hashHistory = [];
                            cachedData.minerHistory = [];
                        }
                        if (cycleCount === 0) {
                            cachedData.hashHistory.unshift({ts: currentTime, hs: cachedData.hash});
                            if (cachedData.hashHistory.length > global.config.general.statsBufferLength) {
                                while (cachedData.hashHistory.length > global.config.general.statsBufferLength) {
                                    cachedData.hashHistory.pop();
                                }
                            }
                            cachedData.minerHistory.unshift({ts: currentTime, cn: cachedData.minerCount});
                            if (cachedData.minerHistory.length > global.config.general.statsBufferLength) {
                                while (cachedData.minerHistory.length > global.config.general.statsBufferLength) {
                                    cachedData.minerHistory.pop();
                                }
                            }
                        }
                    } else {
                        cachedData = {
                            hash: Math.floor(localStats[key] / 600),
                            totalHashes: 0,
                            lastHash: localTimes[key],
                            minerCount: localMinerCount[key],
                            hashHistory: [{ts: currentTime, hs: cachedData.hash}],
                            minerHistory: [{ts: currentTime, cn: cachedData.hash}]
                        };
                    }
                    cache_updates[key + "_stats"] = cachedData;
                });
                minerList.forEach(function (miner) {
                    if (globalMinerList.indexOf(miner) === -1) {
                        globalMinerList.push(miner);
                    }
                    if (miner.indexOf('_') === -1){
                        activeAddresses.push(miner);
                    }
                    let cachedData = global.database.getCache(miner);
                    if (cachedData !== false) {
                        cachedData.hash = Math.floor(localStats.miners[miner] / 600);
                        cachedData.lastHash = localTimes.miners[miner];
                        if (!cachedData.hasOwnProperty("hashHistory")) {
                            cachedData.hashHistory = [];
                        }
                        if (cycleCount === 0){
                            cachedData.hashHistory.unshift({ts: currentTime, hs: cachedData.hash});
                            if (cachedData.hashHistory.length > global.config.general.statsBufferLength) {
                                while (cachedData.hashHistory.length > global.config.general.statsBufferLength) {
                                    cachedData.hashHistory.pop();
                                }
                            }
                        }
                    } else {
                        cachedData = {
                            hash: Math.floor(localStats.miners[miner] / 600),
                            totalHashes: 0,
                            lastHash: localTimes.miners[miner],
                            hashHistory: [{ts: currentTime, hs: cachedData.hash}],
                            goodShares: 0,
                            badShares: 0
                        };
                    }
                    cache_updates[miner] = cachedData;
                });
                globalMinerList.forEach(function (miner) {
                    if (minerList.indexOf(miner) === -1) {
                        let minerStats = global.database.getCache(miner);
                        if (minerStats.hash !== 0) {
                            console.log("Removing: " + miner + " as an active miner from the cache.");
                            if (miner.indexOf('_') > -1) {
                                // This is a worker case.
                                let address_parts = miner.split('_');
                                let address = address_parts[0];
                                let worker = address_parts[1];
                                global.mysql.query("SELECT email FROM users WHERE username = ? AND enable_email IS true limit 1", [address]).then(function (rows) {
                                    if (rows.length === 0) {
                                        return;
                                    }
                                    // toAddress, subject, body
                                    let emailData = {
                                        worker: worker,
                                        timestamp: global.support.formatDate(Date.now()),
                                        poolEmailSig: global.config.general.emailSig
                                    };
                                    global.support.sendEmail(rows[0].email,
                                        sprintf(global.config.email.workerNotHashingSubject, emailData),
                                        sprintf(global.config.email.workerNotHashingBody, emailData));
                                });
                            }
                            minerStats.hash = 0;
                            cache_updates[miner] = minerStats;
                        }
                    }
                });
                Object.keys(identifiers).forEach(function (key) {
                    cache_updates[key + '_identifiers'] = identifiers[key];
                });
                cache_updates['minerList'] = globalMinerList;
                global.database.bulkSetCache(cache_updates);
                callback(null);
            });
        }
    ], function (err, result) {
        cycleCount += 1;
        if (cycleCount === 6){
            cycleCount = 0;
            sock.send(['miner_hash_graph', JSON.stringify(activeAddresses)]);
        }
        sock.send(['miner_hash_stats', JSON.stringify(activeAddresses)]);
    });
    setTimeout(updateShareStats, 10000);
}

function updatePoolStats(poolType) {
    let cache;
    if (typeof(poolType) !== 'undefined') {
        cache = global.database.getCache(poolType + "_stats");
    } else {
        cache = global.database.getCache("global_stats");
    }
    async.series([
        function (callback) {
            debug(threadName + "Checking Influx for last 10min avg for pool stats");
            return callback(null, cache.hash || 0);
        },
        function (callback) {
            debug(threadName + "Checking Influx for last 10min avg for miner count for pool stats");
            return callback(null, cache.minerCount || 0);
        },
        function (callback) {
            debug(threadName + "Checking Influx for last 10min avg for miner count for pool stats");
            return callback(null, cache.totalHashes || 0);
        },
        function (callback) {
            debug(threadName + "Checking MySQL for last block find time for pool stats");
            let cacheData = global.database.getBlockList(poolType);
            if (cacheData.length === 0) {
                return callback(null, 0);
            }
            return callback(null, Math.floor(cacheData[0].ts / 1000));
        },
        function (callback) {
            debug(threadName + "Checking MySQL for last block find time for pool stats");
            let cacheData = global.database.getBlockList(poolType);
            if (cacheData.length === 0) {
                return callback(null, 0);
            }
            return callback(null, cacheData[0].height);
        },
        function (callback) {
            debug(threadName + "Checking MySQL for block count for pool stats");
            return callback(null, global.database.getBlockList(poolType).length);
        },
        function (callback) {
            debug(threadName + "Checking MySQL for total miners paid");
            if (typeof(poolType) !== 'undefined') {
                global.mysql.query("SELECT payment_address, payment_id FROM payments WHERE pool_type = ? group by payment_address, payment_id", [poolType]).then(function (rows) {
                    return callback(null, rows.length);
                });
            } else {
                global.mysql.query("SELECT payment_address, payment_id FROM payments group by payment_address, payment_id").then(function (rows) {
                    return callback(null, rows.length);
                });
            }
        },
        function (callback) {
            debug(threadName + "Checking MySQL for total transactions count");
            if (typeof(poolType) !== 'undefined') {
                global.mysql.query("SELECT distinct(transaction_id) from payments WHERE pool_type = ?", [poolType]).then(function (rows) {
                    return callback(null, rows.length);
                });
            } else {
                global.mysql.query("SELECT count(id) as txn_count FROM transactions").then(function (rows) {
                    if (typeof(rows[0]) !== 'undefined') {
                        return callback(null, rows[0].txn_count);
                    } else {
                        return callback(null, 0);
                    }
                });
            }
        },
        function (callback) {
            debug(threadName + "Checking Influx for last 10min avg for miner count for pool stats");
            return callback(null, cache.roundHashes || 0);
        }
    ], function (err, result) {
        if (typeof(poolType) === 'undefined') {
            poolType = 'global';
        }
        global.database.setCache('pool_stats_' + poolType, {
            hashRate: result[0],
            miners: result[1],
            totalHashes: result[2],
            lastBlockFoundTime: result[3] || 0,
            lastBlockFound: result[4] || 0,
            totalBlocksFound: result[5] || 0,
            totalMinersPaid: result[6] || 0,
            totalPayments: result[7] || 0,
            roundHashes: result[8] || 0
        });
        sock.send(['pool_stats', poolType]);
    });
}

function updatePoolPorts(poolServers) {
    debug(threadName + "Updating pool ports");
    let local_cache = {global: []};
    let portCount = 0;
    global.mysql.query("select * from ports where hidden = 0 and lastSeen >= NOW() - INTERVAL 10 MINUTE").then(function (rows) {
        rows.forEach(function (row) {
            portCount += 1;
            if (!local_cache.hasOwnProperty(row.port_type)) {
                local_cache[row.port_type] = [];
            }
            local_cache[row.port_type].push({
                host: poolServers[row.pool_id],
                port: row.network_port,
                difficulty: row.starting_diff,
                description: row.description,
                miners: row.miners
            });
            if (portCount === rows.length) {
                let local_counts = {};
                let port_diff = {};
                let port_miners = {};
                let pool_type_count = 0;
                let localPortInfo = {};
                for (let pool_type in local_cache) { // jshint ignore:line
                    pool_type_count += 1;
                    local_cache[pool_type].forEach(function (portData) { // jshint ignore:line
                        if (!local_counts.hasOwnProperty(portData.port)) {
                            local_counts[portData.port] = 0;
                        }
                        if (!port_diff.hasOwnProperty(portData.port)) {
                            port_diff[portData.port] = portData.difficulty;
                        }
                        if (!port_miners.hasOwnProperty(portData.port)) {
                            port_miners[portData.port] = 0;
                        }
                        if (port_diff[portData.port] === portData.difficulty) {
                            local_counts[portData.port] += 1;
                            port_miners[portData.port] += portData.miners;
                        }
                        localPortInfo[portData.port] = portData.description;
                        if (local_counts[portData.port] === Object.keys(poolServers).length) {
                            local_cache.global.push({
                                host: {
                                    blockID: local_cache[pool_type][0].host.blockID,
                                    blockIDTime: local_cache[pool_type][0].host.blockIDTime,
                                    hostname: global.config.pool.geoDNS,
                                },
                                port: portData.port,
                                pool_type: pool_type,
                                difficulty: portData.difficulty,
                                miners: port_miners[portData.port],
                                description: localPortInfo[portData.port]
                            });
                        }
                    });
                    if (pool_type_count === Object.keys(local_cache).length) {
                        debug(threadName + "Sending the following to the workers: " + JSON.stringify(local_cache));
                        global.database.setCache('poolPorts', local_cache);
                    }
                }
            }
        });
    });
}

function updatePoolInformation() {
    let local_cache = {};
    debug(threadName + "Updating pool information");
    global.mysql.query("select * from pools where last_checkin >= NOW() - INTERVAL 10 MINUTE").then(function (rows) {
        rows.forEach(function (row) {
            local_cache[row.id] = {
                ip: row.ip,
                blockID: row.blockID,
                blockIDTime: global.support.formatDateFromSQL(row.blockIDTime),
                hostname: row.hostname
            };
            if (Object.keys(local_cache).length === rows.length) {
                global.database.setCache('poolServers', local_cache);
                updatePoolPorts(local_cache);
            }
        });
    });
}

function updateBlockHeader() {
    global.support.rpcDaemon('getlastblockheader', [], function (body) {
        if (body.result && body.result.block_header.hash !== lastBlockHash) {
            lastBlockHash = body.result.block_header.hash;
            global.database.setCache('networkBlockInfo', {
                difficulty: body.result.block_header.difficulty,
                hash: body.result.block_header.hash,
                height: body.result.block_header.height,
                value: body.result.block_header.reward,
                ts: body.result.block_header.timestamp
            });
            sock.send(['network_block_info', JSON.stringify({
                difficulty: body.result.block_header.difficulty,
                hash: body.result.block_header.hash,
                height: body.result.block_header.height,
                value: body.result.block_header.reward,
                ts: body.result.block_header.timestamp
            })]);
        } else if (body.result.block_header.hash === lastBlockHash) {
            console.log("Block headers identical to historical header.  Ignoring");
        } else {
            console.error("GetLastBlockHeader Error during block header update");
        }
    });
}

function updateWalletStats() {
    async.waterfall([
        function (callback) {
            global.support.rpcWallet('getbalance', [], function (body) {
                if (body.result) {
                    return callback(null, {
                        balance: body.result.balance,
                        unlocked: body.result.unlocked_balance,
                        ts: Date.now()
                    });
                } else {
                    return callback(true, "Unable to process balance");
                }
            });
        },
        function (state, callback) {
            global.support.rpcWallet('getheight', [], function (body) {
                if (body.result) {
                    state.height = body.result.height;
                    return callback(null, state);
                } else {
                    return callback(true, "Unable to get current wallet height");
                }
            });
        }
    ], function (err, results) {
        if (err) {
            return console.error("Unable to get wallet stats: " + results);
        }
        global.database.setCache('walletStateInfo', results);
        let history = global.database.getCache('walletHistory');
        if (history === false) {
            history = [];
        }
        history.unshift(results);
        history = history.sort(global.support.tsCompare);
        if (history.length > global.config.general.statsBufferLength) {
            while (history.length > global.config.general.statsBufferLength) {
                history.pop();
            }
        }
        global.database.setCache('walletHistory', history);
    });

}

function monitorNodes() {
    global.mysql.query("SELECT blockID FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)").then(function (rows) {
        global.coinFuncs.getLastBlockHeader(function (block) {
            rows.forEach(function (row) {
                    if (row.blockID < block.height - 3) {
                        global.support.sendEmail(global.config.general.adminEmail, "Pool server behind in blocks", "The pool server: "+row.hostname+" with IP: "+row.ip+" is "+block.height - row.blockID+ " blocks behind");
                    }
                }
            );
        });
    });
}

updateShareStats();
updateBlockHeader();
updatePoolStats();
updatePoolInformation();
updateWalletStats();
monitorNodes();
setInterval(updateBlockHeader, 10000);
setInterval(updatePoolStats, 5000);
setInterval(updatePoolStats, 5000, 'pplns');
setInterval(updatePoolStats, 5000, 'pps');
setInterval(updatePoolStats, 5000, 'solo');
setInterval(updatePoolInformation, 5000);
setInterval(updateWalletStats, 60000);
setInterval(monitorNodes, 300000);