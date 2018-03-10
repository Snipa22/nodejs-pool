"use strict";
const debug = require("debug")("worker");
const async = require("async");
const sprintf = require("sprintf-js").sprintf;

let threadName = "Worker Server ";
let cycleCount = 0;
let lastBlockHash = null;
let lastBlockHeight = null;
let hashrate_avg_min = 5;
let stat_change_alert = 0.3;

let lastBlockCheckIsFailed = {};
let prev_pool_hashrate;
let prev_pool_workers;

let local_cache = {};
let share_cache = {};

function updateShareStats() {
    // This is an omni-worker to deal with all things share-stats related
    // Time based averages are worked out on ring buffers.
    // Buffer lengths?  You guessed it, configured in SQL.
    // Stats timeouts are 30 seconds, so everything for buffers should be there.
    let currentTime = Date.now();
    //let activeAddresses = [];
    async.waterfall([
        function (callback) {
            global.coinFuncs.getLastBlockHeader(function (err, body) {
                if (err !== null){
                    bad_header_start(global.config.daemon.port);
                    return callback(err, "Invalid block header");
                }
                callback(null, body.height + 1);
            });
        },
        function (height, callback) {
            bad_header_stop(global.config.daemon.port);
            console.log("Starting stats collection for " + height + " height");

            const locTime = currentTime - (hashrate_avg_min*60*1000);
            const identifierTime = currentTime - (2*hashrate_avg_min*60*1000);

            let identifiers = {};
            let minerList = [];
            let minerCount = 0;
            let localMinerCount = { pplns: 0, pps: 0, solo: 0, prop: 0, global: 0 };
            let localStats = { pplns: 0, pps: 0, solo: 0, prop: 0, global: 0, miners: {} };
            let localTimes = { pplns: locTime, pps: locTime, solo: locTime, prop: locTime, global: locTime, miners: {} };
            let loopBreakout = 0;

            let new_share_cache = {};

            async.doUntil(function (callback_until) {
                let oldestTime = currentTime;
                let txn = global.database.env.beginTxn({readOnly: true});
                let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
                let found = cursor.goToRange(height) === height;
                let is_use_cache = false;

                if (found && height in share_cache) {
                    let ci = share_cache[height];
                    if (locTime < ci.min_timestamp && ci.last_timestamp && cursor.goToLastDup()) {
                        cursor.getCurrentBinary(function (key, share) { // jshint ignore:line
                            try {
                                share = global.protos.Share.decode(share);
                            } catch (e) {
                                console.error(share);
                                return;
                            }
                            if (share.timestamp === ci.last_timestamp) {
                                debug("Can use share cache on " + height + " height");
                                is_use_cache = true;
                            } else {
                                debug("Found share cache on " + height + " height was modified");
                                found = cursor.goToFirstDup();
                            }
                        });
                    }
                }

                is_use_cache = false;
                found = cursor.goToFirstDup();

                if (is_use_cache) {
                    debug("Using share cache on " + height + " height");
                    let ci = share_cache[height];
                    new_share_cache[height] = ci;

                    if (ci.min_timestamp < oldestTime) oldestTime = ci.min_timestamp;

                    for (let minerID in ci.identifiers) {
                        if (minerID in identifiers) {
                           for (let identifier in ci.identifiers[minerID]) {
                               if (identifiers[minerID].indexOf(identifier) < 0) {
                                   identifiers[minerID].push(identifier);
                                   ++ minerCount;
                               }
                           }
                        } else {
                            identifiers[minerID] = ci.identifiers[minerID];
                            minerCount += ci.identifiers[minerID].length;
                        }
                    }

                    localStats.global += ci.localStats.global;
                    localStats.pplns  += ci.localStats.pplns;
                    localStats.pps    += ci.localStats.pps;
                    localStats.solo   += ci.localStats.solo;
                    if (localTimes.global < ci.localTimes.global) localTimes.global = ci.localTimes.global;
                    if (localTimes.pplns  < ci.localTimes.pplns)  localTimes.pplns  = ci.localTimes.pplns;
                    if (localTimes.pps    < ci.localTimes.pps)    localTimes.pps    = ci.localTimes.pps;
                    if (localTimes.solo   < ci.localTimes.solo)   localTimes.solo   = ci.localTimes.solo;

                    for (let minerID in ci.minerList) {
                        if (minerList.indexOf(minerID) >= 0) {
                            localStats.miners[minerID] += ci.localStats.miners[minerID];
                            if (localTimes.miners[minerID] < ci.localTimes.miners[minerID]) localTimes.miners[minerID] = ci.localTimes.miners[minerID];
                        } else {
                            if (minerID.indexOf('_') < 0) {
                                ++ localMinerCount.global;
                                ++ localMinerCount[ci.localMinerType[minerID]];
                            }
                            localStats.miners[minerID] = ci.localStats.miners[minerID];
                            localTimes.miners[minerID] = ci.localTimes.miners[minerID];
                            minerList.push(minerID);
                        }
                    }

                } else {
                    let ci = {
                        min_timestamp: currentTime,
                        identifiers: {},
                        minerList: [],
                        localMinerType: {},
                        localStats: { pplns: 0, pps: 0, solo: 0, prop: 0, global: 0, miners: {} },
                        localTimes: { pplns: locTime, pps: locTime, solo: locTime, prop: locTime, global: locTime, miners: {} },
                    };
                    let is_add_new_share_cache_item = true;
                    let count = 0;
                    for (; found; ++ count, found = cursor.goToNextDup()) cursor.getCurrentBinary(function (key, share) {  // jshint ignore:line
                        try {
                            share = global.protos.Share.decode(share);
                        } catch (e) {
                            console.error(share);
                            is_add_new_share_cache_item = false;
                            return;
                        }
                        if (share.timestamp < oldestTime) oldestTime = share.timestamp;
                        if (share.timestamp <= identifierTime) {
                            is_add_new_share_cache_item = false;
                            return;
                        }

                        let minerID = typeof(share.paymentID) !== 'undefined' && share.paymentID.length > 10
                                      ? share.paymentAddress + '.' + share.paymentID : share.paymentAddress;

                        if (minerID in identifiers) {
                           if (identifiers[minerID].indexOf(share.identifier) < 0) {
                               identifiers[minerID].push(share.identifier);
                               ++ minerCount;
                           }
                        } else {
                            identifiers[minerID] = [share.identifier];
                            ++ minerCount;
                        }

                        if (share.timestamp <= locTime) {
                            is_add_new_share_cache_item = false;
                            return;
                        }

                        let minerIDWithIdentifier = minerID + "_" + share.identifier;
                        localStats.global += share.shares;
                        if (localTimes.global < share.timestamp) localTimes.global = share.timestamp;
                        let minerType;
                        switch (share.poolType) {
                            case global.protos.POOLTYPE.PPLNS:
                                minerType = 'pplns';
                                localStats.pplns += share.shares;
                                if (localTimes.pplns < share.timestamp) localTimes.pplns = share.timestamp;
                                break;
                            case global.protos.POOLTYPE.PPS:
                                localStats.pps += share.shares;
                                minerType = 'pps';
                                if (localTimes.pps < share.timestamp) localTimes.pps = share.timestamp;
                                break;
                            case global.protos.POOLTYPE.SOLO:
                                localStats.solo += share.shares;
                                minerType = 'solo';
                                if (localTimes.solo < share.timestamp) localTimes.solo = share.timestamp;
                                break;
                        }
                        if (minerList.indexOf(minerID) >= 0) {
                            localStats.miners[minerID] += share.shares;
                            if (localTimes.miners[minerID] < share.timestamp) localTimes.miners[minerID] = share.timestamp;
                        } else {
                            ++ localMinerCount[minerType];
                            ++ localMinerCount.global;
                            localStats.miners[minerID] = share.shares;
                            localTimes.miners[minerID] = share.timestamp;
                            minerList.push(minerID);
                        }
                        if (minerList.indexOf(minerIDWithIdentifier) >= 0) {
                            localStats.miners[minerIDWithIdentifier] += share.shares;
                            if (localTimes.miners[minerIDWithIdentifier] < share.timestamp) localTimes.miners[minerIDWithIdentifier] = share.timestamp;
                        } else {
                            localStats.miners[minerIDWithIdentifier] = share.shares;
                            localTimes.miners[minerIDWithIdentifier] = share.timestamp;
                            minerList.push(minerIDWithIdentifier);
                        }

                        // share cache item
                        if (is_add_new_share_cache_item) {
                            if (share.timestamp < ci.min_timestamp) ci.min_timestamp = share.timestamp;
                            ci.last_timestamp = share.timestamp;

                            if (minerID in ci.identifiers) {
                               if (ci.identifiers[minerID].indexOf(share.identifier) < 0) {
                                   ci.identifiers[minerID].push(share.identifier);
                               }
                            } else {
                               ci.identifiers[minerID] = [share.identifier];
                            }

                            ci.localStats.global += share.shares;
                            if (ci.localTimes.global <= share.timestamp) ci.localTimes.global = share.timestamp;
                            switch (share.poolType) {
                                case global.protos.POOLTYPE.PPLNS:
                                    ci.localStats.pplns += share.shares;
                                    if (ci.localTimes.pplns <= share.timestamp) ci.localTimes.pplns = share.timestamp;
                                    break;
                                case global.protos.POOLTYPE.PPS:
                                    ci.localStats.pps += share.shares;
                                    if (ci.localTimes.pps <= share.timestamp) ci.localTimes.pps = share.timestamp;
                                    break;
                                case global.protos.POOLTYPE.SOLO:
                                    ci.localStats.solo += share.shares;
                                    if (ci.localTimes.solo <= share.timestamp) ci.localTimes.solo = share.timestamp;
                                    break;
                            }
                            if (ci.minerList.indexOf(minerID) >= 0) {
                                ci.localStats.miners[minerID] += share.shares;
                                if (ci.localTimes.miners[minerID] < share.timestamp) ci.localTimes.miners[minerID] = share.timestamp;
                            } else {
                                ci.localMinerType[minerID] = minerType;
                                ci.localStats.miners[minerID] = share.shares;
                                ci.localTimes.miners[minerID] = share.timestamp;
                                ci.minerList.push(minerID);
                            }
                            if (ci.minerList.indexOf(minerIDWithIdentifier) >= 0) {
                                ci.localStats.miners[minerIDWithIdentifier] += share.shares;
                                if (ci.localTimes.miners[minerIDWithIdentifier] < share.timestamp) ci.localTimes.miners[minerIDWithIdentifier] = share.timestamp;
                            } else {
                                ci.localStats.miners[minerIDWithIdentifier] = share.shares;
                                ci.localTimes.miners[minerIDWithIdentifier] = share.timestamp;
                                ci.minerList.push(minerIDWithIdentifier);
                            }
                        }
                    });
                    debug("On " + height + " height iterated " + count + " elements");
                    if (is_add_new_share_cache_item) {
                        debug("Added new cache item on " + height + " height");
                        new_share_cache[height] = ci;
                    }
                }
                cursor.close();
                txn.abort();
                return callback_until(null, oldestTime);

            }, function (oldestTime) {
                return ++loopBreakout > 60 || --height < 0 || oldestTime <= identifierTime;

            }, function (err) {
                share_cache = new_share_cache;
                debug("Share loop: " + ((Date.now() - currentTime) / 1000) + " seconds");
                let prevMinerList = global.database.getCache('minerList');
                if (prevMinerList === false) prevMinerList = minerList;
                let cache_updates = {};
                // pplns: 0, pps: 0, solo: 0, prop: 0, global: 0
                ['pplns', 'pps', 'solo', 'prop', 'global'].forEach(function (key) {
                    let cachedData = global.database.getCache(key + "_stats");
                    if (cachedData !== false) {
                        cachedData.hash = Math.floor(localStats[key] / (hashrate_avg_min*60)) + 1;
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
                            hash: Math.floor(localStats[key] / (hashrate_avg_min*60)) + 1,
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
                    //if (miner.indexOf('_') === -1){
                    //    activeAddresses.push(miner);
                    //}
                    let cachedData;
                    let keyHistory = "history:" + miner;
                    if (miner in local_cache) {
                        cachedData = local_cache[miner];
                    } else {
                        cachedData = global.database.getCache(keyHistory);
                        if (cachedData === false) cachedData = global.database.getCache(miner); // for compatibility
                    }
                    if (cachedData !== false) {
                        cachedData.hash = Math.floor(localStats.miners[miner] / (hashrate_avg_min*60)) + 1;
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
                            hash: Math.floor(localStats.miners[miner] / (hashrate_avg_min*60)) + 1,
                            totalHashes: 0,
                            lastHash: localTimes.miners[miner],
                            hashHistory: [{ts: currentTime, hs: cachedData.hash}],
                            goodShares: 0,
                            badShares: 0
                        };
                    }
                    cache_updates[keyHistory] = cachedData;
                    local_cache[miner] = cachedData;
                });

                // remove old workers
                prevMinerList.forEach(function (miner) {
                    if (minerList.indexOf(miner) !== -1) return; // we still have this miner in current list
                    //debug("Removing: " + miner + " as an active miner from the cache.");
                    let minerStats = global.database.getCache(miner);
                    if (!minerStats) return;
                    minerStats.hash = 0;
                    cache_updates[miner] = minerStats;
                    if (miner.indexOf('_') <= -1) return;

                    // This is a worker case.
                    let address_parts = miner.split(/_(.+)/);
                    let address = address_parts[0];
                    get_address_email(address, function (email) {
                        setTimeout(delayed_send_worker_stopped_hashing_email, 5*60*1000, miner, email, currentTime);
                    });
                });

                // find new workers
                minerList.forEach(function (miner) {
                    if (prevMinerList.indexOf(miner) !== -1) return; // we still have this miner in previous list
                    //debug("Adding: " + miner + " as an active miner to the cache.");
                    if (miner.indexOf('_') <= -1) return;

                    // This is a worker case.
                    let address_parts = miner.split(/_(.+)/);
                    let address = address_parts[0];
                    get_address_email(address, function (email) {
                        send_worker_started_hashing_email(miner, email, currentTime);
                    });
                });

                Object.keys(identifiers).forEach(function (key) {
                    cache_updates[key + '_identifiers'] = identifiers[key];
                });
                cache_updates.minerList = minerList;
                global.database.bulkSetCache(cache_updates);
                let pool_hashrate       = Math.floor(localStats.global / (hashrate_avg_min*60)) + 1;
                let pool_hashrate_ratio = prev_pool_hashrate ? pool_hashrate / prev_pool_hashrate : 1;
                let pool_workers        = minerCount;
                let pool_workers_ratio  = prev_pool_workers ? pool_workers / prev_pool_workers : 1;
                console.log("Processed " + minerCount + " workers for " + ((Date.now() - currentTime) / 1000) + " seconds. Pool hashrate is: " + pool_hashrate);
                if (pool_hashrate_ratio < (1-stat_change_alert) || pool_hashrate_ratio > (1+stat_change_alert) ||
                    pool_workers_ratio < (1-stat_change_alert) || pool_workers_ratio > (1+stat_change_alert)) {
                    global.support.sendEmail(global.config.general.adminEmail,
			"FYI: Pool hashrate/workers changed significantly",
			"Pool hashrate changed from "          + prev_pool_hashrate + " to " + pool_hashrate + " (" + pool_hashrate_ratio + ")\n" +
			"Pool number of workers changed from " + prev_pool_workers  + " to " + pool_workers  + " (" + pool_workers_ratio  + ")"
		    );
                }
                prev_pool_hashrate = pool_hashrate;
                prev_pool_workers  = pool_workers;
                callback(null);
            });
        }
    ], function (err, result) {
        if (++cycleCount === 3) cycleCount = 0;
        setTimeout(updateShareStats, 10*1000);
    });
}

// cached email of specific address
let minerEmail = {};
// time of last SQL check for specific address
let minerEmailTime = {};

// worker name -> time
let workers_started_hashing_time = {};
let workers_stopped_hashing_email_time = {};

function get_address_email(address, callback) {
    let currentTime = Date.now();
    if (!(address in minerEmailTime) || currentTime - minerEmailTime[address] > 10*60*1000) {
        minerEmailTime[address] = currentTime;
        global.mysql.query("SELECT email FROM users WHERE username = ? AND enable_email IS true limit 1", [address]).then(function (rows) {
            if (rows.length === 0) {
                delete minerEmail[address];
                return;
            } else {
                minerEmail[address] = rows[0].email;
            }
            callback(minerEmail[address]);
        });
    } else if (address in minerEmail) {
        callback(minerEmail[address]);
    }
}

function send_worker_started_hashing_email(miner, email, currentTime) {
    workers_started_hashing_time[miner] = currentTime;
    if (miner in workers_stopped_hashing_email_time) {
        delete workers_stopped_hashing_email_time[miner];

        let address_parts = miner.split(/_(.+)/);
        let address = address_parts[0];
        let worker  = address_parts[1];
        // toAddress, subject, body
        let emailData = {
            worker: worker,
            timestamp: global.support.formatDate(currentTime),
            poolEmailSig: global.config.general.emailSig
        };
        global.support.sendEmail(email,
            sprintf(global.config.email.workerStartHashingSubject, emailData),
            sprintf(global.config.email.workerStartHashingBody,    emailData),
            address
        );
    }
}

function delayed_send_worker_stopped_hashing_email(miner, email, currentTime) {
    if (miner in workers_started_hashing_time && Date.now() - workers_started_hashing_time[miner] <= 5*60*1000) {
        delete workers_started_hashing_time[miner];
        return;
    }

    delete workers_started_hashing_time[miner];
    workers_stopped_hashing_email_time[miner] = Date.now();

    let address_parts = miner.split(/_(.+)/);
    let address = address_parts[0];
    let worker  = address_parts[1];
    // toAddress, subject, body
    let emailData = {
        worker: worker,
        timestamp: global.support.formatDate(currentTime),
        poolEmailSig: global.config.general.emailSig
    };

    global.support.sendEmail(email,
        sprintf(global.config.email.workerNotHashingSubject, emailData),
        sprintf(global.config.email.workerNotHashingBody,    emailData),
        address
    );
}

function updatePoolStats(poolType) {
    if (global.config.daemon.activePort) {
        global.support.getActivePort(function (newActivePort) {
            if (newActivePort) global.config.daemon.activePort = newActivePort;
            updatePoolStats2(poolType);
        });
    } else {
        updatePoolStats2(poolType);
    }
}

function updatePoolStats2(poolType) {
    let cache;
    let port_suffix = global.config.daemon.activePort && global.config.daemon.activePort !== global.config.daemon.port ? "_" + global.config.daemon.activePort.toString() : "";
    if (typeof(poolType) !== 'undefined') {
        cache = global.database.getCache(poolType + "_stats");
        if (port_suffix === "") {
            let cache2 = global.database.getCache(poolType + "_stats2");
            cache.totalHashes = cache2.totalHashes;
            cache.roundHashes = cache2.roundHashes;
        } else {
            let cache2_total = global.database.getCache(poolType + "_stats2");
            let cache2_round = global.database.getCache(poolType + "_stats2" + port_suffix);
            cache.totalHashes = cache2_total.totalHashes;
            cache.roundHashes = cache2_round.roundHashes;
        }
    } else {
        cache = global.database.getCache("global_stats");
        if (port_suffix === "") {
            let cache2 = global.database.getCache("global_stats2");
            cache.totalHashes = cache2.totalHashes;
            cache.roundHashes = cache2.roundHashes;
        } else {
            let cache2_total = global.database.getCache("global_stats2");
            let cache2_round = global.database.getCache("global_stats2" + port_suffix);
            cache.totalHashes = cache2_total.totalHashes;
            cache.roundHashes = cache2_round.roundHashes;
        }
    }

    let blockList = global.database.getBlockList(poolType);
    let altblockList = global.database.getAltBlockList(poolType);

    async.series([
        function (callback) {
            //debug(threadName + "Checking Influx for last 5min avg for pool stats (hashRate)");
            return callback(null, cache.hash || 0);
        },
        function (callback) {
            //debug(threadName + "Checking Influx for last 5min avg for miner count for pool stats (miners)");
            return callback(null, cache.minerCount || 0);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for totalHashes");
            return callback(null, cache.totalHashes || 0);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB for lastBlockFoundTime for pool stats");
            let max_time = 0;
            if (blockList.length !== 0) {
                max_time = Math.floor(blockList[0].ts / 1000);
            }
            if (altblockList.length !== 0) {
                max_time = Math.max(max_time, Math.floor(altblockList[0].ts / 1000));
            }
            return callback(null, max_time);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB for lastBlockFound height for pool stats");
            if (blockList.length === 0) {
                return callback(null, 0);
            }
            return callback(null, blockList[0].height);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB for totalBlocksFound for pool stats");
            return callback(null, blockList.length);
        },
        function (callback) {
            //debug(threadName + "Checking MySQL for total miners paid");
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
            //debug(threadName + "Checking MySQL for total transactions count");
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
            //debug(threadName + "Checking LMDB cache for roundHashes");
            return callback(null, cache.roundHashes || 0);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB for altblock count for pool stats");
            return callback(null, altblockList.length);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB for altBlocksFound array for each specific port");
            let result = {};
            for (let i in altblockList) {
                let block = altblockList[i];
                if (result.hasOwnProperty(block.port)) ++ result[block.port];
                else result[block.port] = 1;
            } 
            return callback(null, result);
        },
        function (callback) {
            //debug(threadName + "Checking MySQL for activePort value");
            return callback(null, global.config.daemon.activePort ? global.config.daemon.activePort : global.config.daemon.port);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for xmr_profit value");
	    let xmr_profit = global.database.getCache('xmr_profit');
            return callback(null, xmr_profit ? xmr_profit.value : 0);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for xmr_profit_comment value");
	    let xmr_profit_comment = global.database.getCache('xmr_profit_comment');
            return callback(null, xmr_profit_comment ? xmr_profit_comment.value : "");
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for min_block_rewards value to set minBlockRewards");
            let min_block_rewards = global.database.getCache('min_block_rewards');
            return callback(null, min_block_rewards ? min_block_rewards : {});
        }
    ], function (err, result) {
        if (typeof(poolType) === 'undefined') {
            poolType = 'global';
            updateBlockHeader();
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
            roundHashes: result[8] || 0,
	    totalAltBlocksFound: result[9] || 0,
	    altBlocksFound: result[10] || {},
            activePort: result[11] || 0,
            activePortProfit: result[12] || 0,
            activePortComment: result[13] || "",
            minBlockRewards: result[14] || {}
        });
    });
}

function updatePoolPorts(poolServers) {
    //debug(threadName + "Updating pool ports");
    let local_cache = {global: []};
    let portCount = 0;
    global.mysql.query("select * from ports where hidden = 0 and pool_id < 1000 and lastSeen >= NOW() - INTERVAL 10 MINUTE").then(function (rows) {
        rows.forEach(function (row) {
            ++ portCount;
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
                    ++ pool_type_count;
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
                            ++ local_counts[portData.port];
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
                        //debug(threadName + "Sending the following to the workers: " + JSON.stringify(local_cache));
                        global.database.setCache('poolPorts', local_cache);
                    }
                }
            }
        });
    });
}

function updatePoolInformation() {
    let local_cache = {};
    //debug(threadName + "Updating pool information");
    global.mysql.query("select * from pools where id < 1000 and last_checkin >= NOW() - INTERVAL 10 MINUTE").then(function (rows) {
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
    global.coinFuncs.getLastBlockHeader(function(main_err, main_body){
        if (main_err !== null) {
            console.error("Last block header request failed!");
            return;
        }
        global.coinFuncs.getPortLastBlockHeader(global.config.daemon.activePort, function(err, body){
            if (err !== null) {
                console.error("Last block header request failed for " + global.config.daemon.activePort + " port!");
                return;
            }
            if (body.hash !== lastBlockHash || main_body.height !== lastBlockHeight) {
            	lastBlockHash = body.hash;
            	lastBlockHeight = main_body.height;
                global.database.setCache('networkBlockInfo', {
                    difficulty: body.difficulty,
                    hash: body.hash,
                    height: body.height,
                    main_height: main_body.height,
                    value: body.reward,
                    ts: body.timestamp
                });
            }
        });
    });
}

function updateWalletStats() {
    async.waterfall([
        function (callback) {
            // Todo: Implement within the coins/<coin>.js file.
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
            // Todo: Implement within the coins/<coin>.js file.
            global.support.rpcWallet('getheight', [], function (body) {
                if (body.result) {
                    state.height = body.result.height;
                    return callback(null, state);
                } else if (typeof body.error !== 'undefined' && body.error.message === 'Method not found') {
                    state.height = 0;
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

function bad_header_start(port) {
    console.error("Issue in getting block header for " + port + " port. Skipping node monitor");
    if (!(port in lastBlockCheckIsFailed)) {
        lastBlockCheckIsFailed[port] = 1;
        global.support.sendEmail(
            global.config.general.adminEmail,
            'Failed to query daemon for ' + port + ' port for last block header',
            `The worker failed to return last block header for ` + port + ` port. Please verify if the daemon is running properly.`
        );
    }
    return;
}

function bad_header_stop(port) {
    if (port in lastBlockCheckIsFailed) {
        delete lastBlockCheckIsFailed[port];
        global.support.sendEmail(
            global.config.general.adminEmail,
            'Quering daemon for ' + port + ' port for last block header is back to normal',
            `An warning was sent to you indicating that the the worker failed to return the last block header for ${port} port.
             The issue seems to be solved now.`
        );
    }
}

function monitorNodes() {
    global.mysql.query("SELECT blockID, hostname, ip, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)").then(function (rows) {
        rows.forEach(function (row) {
            let port = row.port ? row.port : global.config.daemon.port;
            global.coinFuncs.getPortLastBlockHeader(port, function (err, block) {
                if (err !== null){
                    bad_header_start(port);
                    return;
                }
                bad_header_stop();
                if (row.blockID < block.height - 3) {
                    global.support.sendEmail(global.config.general.adminEmail,
			"Pool server behind in blocks",
			"The pool server: "+row.hostname+" with IP: "+row.ip+" is "+(block.height - row.blockID)+ " blocks behind for " + port + " port"
		    );
                }
            });
        });
    });
}

updateShareStats();
updatePoolStats();
updatePoolInformation();
updateWalletStats();
monitorNodes();
setInterval(updatePoolStats, 5*1000);
setInterval(updatePoolStats, 5*1000, 'pplns');
if (global.config.pps.enable === true)  setInterval(updatePoolStats, 5*1000, 'pps');
if (global.config.solo.enable === true) setInterval(updatePoolStats, 5*1000, 'solo');
setInterval(updatePoolInformation, 5*1000);
setInterval(updateWalletStats, 60*1000);
setInterval(monitorNodes, 5*60*1000);
// clean local_cache from time to time
setInterval(function() { local_cache = {}; } , 4*60*60*1000);
