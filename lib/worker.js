"use strict";
const debug = require("debug")("worker");
const async = require("async");
const sprintf = require("sprintf-js").sprintf;

let threadName = "Worker Server ";
let cycleCount = 0;
let hashrate_avg_min = 10;
let stat_change_alert = 0.3;

let lastBlockCheckIsFailed = {};
let prev_pool_state_time;
let prev_pool_hashrate;
let prev_pool_workers;

let stats_cache = {};



function updateShareStats() {
    // This is an omni-worker to deal with all things share-stats related
    // Time based averages are worked out on ring buffers.
    // Buffer lengths?  You guessed it, configured in SQL.
    // Stats timeouts are 30 seconds, so everything for buffers should be there.
    let currentTime = Date.now();
    // power to ensure we can keep up to global.config.general.statsBufferHours in global.config.general.statsBufferLength array
    // here N = log(history_power, global.config.general.statsBufferLength) is number of attemps required on average to remove top left history point (the oldest one)
    // we just select history_power so that is till happen on global.config.general.statsBufferHours * 60 attemps on average
    const history_power = Math.log(global.config.general.statsBufferLength) / Math.log(global.config.general.statsBufferHours * 60);

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
            console.log("Starting stats collection for " + height + " height (history power: " + history_power + ")");

            const locTime = currentTime - (hashrate_avg_min*60*1000);
            const identifierTime = currentTime - (2*hashrate_avg_min*60*1000);

            let identifiers = {};
            let minerSet = {};
            let minerPortSet = {};
            let minerCount = 0;
            let localMinerCount = { pplns: 0, pps: 0, solo: 0, prop: 0, global: 0 };
            let localStats = { pplns: 0, pps: 0, solo: 0, prop: 0, global: 0, miners: {}, miners2: {} };
            let localPortHashes = {};
            let localTimes = { pplns: locTime, pps: locTime, solo: locTime, prop: locTime, global: locTime, miners: {} };
            let loopBreakout = 0;

            async.doUntil(function (callback_until) {
                let oldestTime = currentTime;
                let txn = global.database.env.beginTxn({readOnly: true});
                let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
                let count = 0;
                for (let found = cursor.goToRange(height) === height; found; ++ count, found = cursor.goToNextDup()) {
                    cursor.getCurrentBinary(function (key, share) {  // jshint ignore:line
                        try {
                            share = global.protos.Share.decode(share);
                        } catch (e) {
                            console.error(share);
                            return;
                        }
                        if (share.timestamp < oldestTime) oldestTime = share.timestamp;
                        if (share.timestamp <= identifierTime) return;

                        let minerID = typeof(share.paymentID) !== 'undefined' && share.paymentID.length > 10
                                      ? share.paymentAddress + '.' + share.paymentID : share.paymentAddress;

			const identifier = share.identifier;

                        if (minerID in identifiers) {
                           if (identifiers[minerID].indexOf(identifier) < 0) {
                               identifiers[minerID].push(identifier);
                               ++ minerCount;
                           }
                        } else {
                            identifiers[minerID] = [identifier];
                            ++ minerCount;
                        }

                        if (share.timestamp <= locTime) return;

                        let minerIDWithIdentifier = minerID + "_" + identifier;
                        const shares2 = share.shares2;
                        localStats.global += shares2;
                        if (localTimes.global < share.timestamp) localTimes.global = share.timestamp;
                        let minerType;
                        switch (share.poolType) {
                            case global.protos.POOLTYPE.PPLNS:
                                minerType = 'pplns';
                                localStats.pplns += shares2;
                                if (localTimes.pplns < share.timestamp) localTimes.pplns = share.timestamp;
                                break;
                            case global.protos.POOLTYPE.PPS:
                                localStats.pps += shares2;
                                minerType = 'pps';
                                if (localTimes.pps < share.timestamp) localTimes.pps = share.timestamp;
                                break;
                            case global.protos.POOLTYPE.SOLO:
                                localStats.solo += shares2;
                                minerType = 'solo';
                                if (localTimes.solo < share.timestamp) localTimes.solo = share.timestamp;
                                break;
                        }

                        const port = typeof(share.port) !== 'undefined' && share.port ? share.port : global.config.daemon.port;
                        if (port in localPortHashes) localPortHashes[port] += share.shares;
                        else localPortHashes[port] = share.shares;

                        if (!shares2) return; // use virtual shares from child block mining only for global pool stats

                        if (minerID in minerPortSet) {
                            localStats.miners[minerID]  += share.shares;
                            localStats.miners2[minerID] += shares2;
                            if (localTimes.miners[minerID] < share.timestamp) localTimes.miners[minerID] = share.timestamp;
                        } else {
                            ++ localMinerCount[minerType];
                            ++ localMinerCount.global;
                            localStats.miners[minerID]  = share.shares;
                            localStats.miners2[minerID] = shares2;
                            localTimes.miners[minerID]  = share.timestamp;
                            minerSet[minerID] = 1;
                            minerPortSet[minerID] = port;
                        }

                        if (minerIDWithIdentifier in minerSet) {
                            localStats.miners[minerIDWithIdentifier]  += share.shares;
                            localStats.miners2[minerIDWithIdentifier] += shares2;
                            if (localTimes.miners[minerIDWithIdentifier] < share.timestamp) localTimes.miners[minerIDWithIdentifier] = share.timestamp;
                        } else {
                            localStats.miners[minerIDWithIdentifier]  = share.shares;
                            localStats.miners2[minerIDWithIdentifier] = shares2;
                            localTimes.miners[minerIDWithIdentifier]  = share.timestamp;
                            minerSet[minerIDWithIdentifier] = 1;
                        }
                    });
                }
                cursor.close();
                txn.abort();
                debug("On " + height + " height iterated " + count + " elements");
                return callback_until(null, oldestTime);

            }, function (oldestTime) {
                return ++loopBreakout > 60 || --height < 0 || oldestTime <= identifierTime;

            }, function (err) {
                debug("Share loop: " + ((Date.now() - currentTime) / 1000) + " seconds");
                let prevMinerSet = global.database.getCache('minerSet');
                if (prevMinerSet === false) prevMinerSet = minerSet;
                let cache_updates = {};
                // pplns: 0, pps: 0, solo: 0, prop: 0, global: 0
                ['pplns', 'pps', 'solo', 'prop', 'global'].forEach(function (key) {
                    const hash       = Math.floor(localStats[key] / (hashrate_avg_min*60)) + 1;
                    const lastHash   = localTimes[key];
                    const minerCount = localMinerCount[key];
                    let cachedData = global.database.getCache(key + "_stats");
                    if (cachedData !== false) {
                        cachedData.hash       = hash;
                        cachedData.lastHash   = lastHash;
                        cachedData.minerCount = minerCount;
                        if (!cachedData.hasOwnProperty("hashHistory")) {
                            cachedData.hashHistory  = [];
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
                            hash: hash,
                            totalHashes: 0,
                            lastHash: lastHash,
                            minerCount: minerCount,
                            hashHistory:  [{ts: currentTime, hs: hash}],
                            minerHistory: [{ts: currentTime, cn: minerCount}]
                        };
                    }
                    cache_updates[key + "_stats"] = cachedData;
                });
                for (let port in localPortHashes) localPortHashes[port] = Math.floor(localPortHashes[port] / (hashrate_avg_min*60)) + 1;
                cache_updates["port_hash"] = localPortHashes;
                for (let miner in minerSet) {
                    let stats;
                    let keyStats   = "stats:" + miner;
                    let keyHistory = "history:" + miner;

                    if (miner in stats_cache) {
                        stats = stats_cache[miner];
                    } else {
                        stats = global.database.getCache(keyStats);
                        if (!stats) stats = {};
                        let history_stats = global.database.getCache(keyHistory);
                        if (history_stats) {
                            stats.hashHistory = history_stats.hashHistory;
                        } else {
                            stats.hashHistory = [];
                        }
                    }

                    stats.hash  = Math.floor(localStats.miners[miner]  / (hashrate_avg_min*60)) + 1;
                    stats.hash2 = Math.floor(localStats.miners2[miner] / (hashrate_avg_min*60)) + 1;
                    stats.lastHash = localTimes.miners[miner];
                    cache_updates[keyStats] = { hash: stats.hash, hash2: stats.hash2, lastHash: stats.lastHash };

                    if (cycleCount === 0) {
                        stats.hashHistory.unshift({ts: currentTime, hs: stats.hash, hs2: stats.hash2});
                        if (stats.hashHistory.length > global.config.general.statsBufferLength) {
                            while (stats.hashHistory.length > global.config.general.statsBufferLength) {
                                const last_index = stats.hashHistory.length - 1;
                                if ((currentTime - stats.hashHistory[last_index].ts) / 1000 / 3600 > global.config.general.statsBufferHours) {
                                    stats.hashHistory.pop();
                                } else {
                                    // here we remove larger indexes (that are more distant in time) with more probability
                                    const index_to_remove = (last_index * (1 - Math.pow(Math.random(), history_power))).toFixed();
                                    stats.hashHistory.splice(index_to_remove, 1);
                                }
                            }
                        }
                        cache_updates[keyHistory] = { hashHistory: stats.hashHistory };
                    }

                    stats_cache[miner] = stats;
                }
                debug("History loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

                // remove old workers
                for (let miner in prevMinerSet) {
                    if (miner in minerSet) continue; // we still have this miner in current set
                    //debug("Removing: " + miner + " as an active miner from the cache.");
                    let minerStats = global.database.getCache(miner);
                    if (!minerStats) continue;
                    minerStats.hash = 0;
                    cache_updates[miner] = minerStats;
                    if (miner.indexOf('_') <= -1) continue;

                    // This is a worker case.
                    let address_parts = miner.split(/_(.+)/);
                    let address = address_parts[0];
                    get_address_email(address, function (email) {
                        setTimeout(delayed_send_worker_stopped_hashing_email, 5*60*1000, miner, email, currentTime);
                    });
                }

                debug("Old worker loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

                // find new workers
                for (let miner in minerSet) {
                    if (miner in prevMinerSet) continue; // we still have this miner in previous set
                    //debug("Adding: " + miner + " as an active miner to the cache.");
                    if (miner.indexOf('_') <= -1) continue;

                    // This is a worker case.
                    let address_parts = miner.split(/_(.+)/);
                    let address = address_parts[0];
                    get_address_email(address, function (email) {
                        send_worker_started_hashing_email(miner, email, currentTime);
                    });
                }

                debug("New worker loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

                Object.keys(identifiers).forEach(function (key) {
                    cache_updates['identifiers:' + key] = identifiers[key];
                });
                let portMinerCount = {};
                for (let miner in minerPortSet) {
                    const port = minerPortSet[miner];
                    if (port in portMinerCount) ++ portMinerCount[port];
                    else portMinerCount[port] = 1;
                }
                cache_updates.portMinerCount = portMinerCount;
                cache_updates.minerSet = minerSet;
                global.database.bulkSetCache(cache_updates);

                let pool_hashrate = Math.floor(localStats.global / (hashrate_avg_min*60)) + 1;
                let pool_workers  = minerCount;
                console.log("Processed " + minerCount + " workers for " + ((Date.now() - currentTime) / 1000) + " seconds. Pool hashrate is: " + pool_hashrate);
                if (!prev_pool_state_time || currentTime - prev_pool_state_time > hashrate_avg_min*60*1000) {
                    let pool_hashrate_ratio = prev_pool_hashrate ? pool_hashrate / prev_pool_hashrate : 1;
                    let pool_workers_ratio  = prev_pool_workers ? pool_workers / prev_pool_workers : 1;
                    if (pool_hashrate_ratio < (1-stat_change_alert) || pool_hashrate_ratio > (1+stat_change_alert) ||
                        pool_workers_ratio < (1-stat_change_alert) || pool_workers_ratio > (1+stat_change_alert)) {
                        global.support.sendEmail(global.config.general.adminEmail,
	                    "FYI: Pool hashrate/workers changed significantly",
			    "Pool hashrate changed from "          + prev_pool_hashrate + " to " + pool_hashrate + " (" + pool_hashrate_ratio + ")\n" +
			    "Pool number of workers changed from " + prev_pool_workers  + " to " + pool_workers  + " (" + pool_workers_ratio  + ")\n"
		        );
                    }
                    prev_pool_hashrate = pool_hashrate;
                    prev_pool_workers  = pool_workers;
                    prev_pool_state_time = currentTime;
                }
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
    global.support.getActivePort("", function (newActivePort) {
        if (newActivePort) global.config.daemon.activePort = newActivePort;
        updatePoolStats2(poolType);
    });
}

let price_btc = 0;
let price_usd = 0;
let price_eur = 0;
let min_block_rewards = {};

function updatePoolStats2(poolType) {
    let cache;
    let port_suffix = global.config.daemon.activePort !== global.config.daemon.port ? "_" + global.config.daemon.activePort.toString() : "";
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

    let port_hash = global.database.getCache('port_hash');
    let blockList = global.database.getBlockList(poolType);
    let altblockList = global.database.getAltBlockList(poolType);
    let min_block_rewards2 = global.database.getCache('min_block_rewards');
    if (min_block_rewards2) min_block_rewards = min_block_rewards2;
    if (!(global.config.daemon.port in min_block_rewards)) min_block_rewards[global.config.daemon.port] = 0;

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
            return callback(null, global.config.daemon.activePort);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for active_ports value");
	    let active_ports = global.database.getCache('active_ports');
            return callback(null, active_ports ? active_ports : []);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for xmr_profit value");
            let xmr_profit = global.database.getCache('xmr_profit');
            return callback(null, xmr_profit ? xmr_profit.value : 0);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for coin_profit value");
            let coin_xmr_profit = global.database.getCache('coin_xmr_profit');
            return callback(null, coin_xmr_profit ? coin_xmr_profit : {});
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for xmr_profit_comment value");
	    let coin_comment = global.database.getCache('coin_comment');
            return callback(null, coin_comment ? coin_comment : {});
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for min_block_rewards value to set minBlockRewards");
            return callback(null, min_block_rewards);
        },
        function (callback) {
            let pending = 0;
            for (let i in blockList) {
                const block = blockList[i];
                if (block.valid === true && block.unlocked === false) pending += global.support.coinToDecimal(block.value);
            }
            for (let i in altblockList) {
                const altblock = altblockList[i];
                if (altblock.valid === true && altblock.unlocked === false) pending += altblock.port in min_block_rewards ? min_block_rewards[altblock.port] : 0;
            }
            return callback(null, pending);
        },
        function (callback) {
            if (typeof(poolType) === 'undefined') {
                global.support.https_get("https://api.coinmarketcap.com/v1/ticker/" + global.config.coin.name + "/?convert=EUR", function (res) {
                    if (res != null && res instanceof Array && res.length === 1 && typeof(res[0].price_usd) !== 'undefined' && typeof(res[0].price_eur) !== 'undefined') {
                        price_btc = parseFloat(res[0].price_btc);
                        price_usd = parseFloat(res[0].price_usd);
                        price_eur = parseFloat(res[0].price_eur);
                    }
                    return callback(null, { btc: price_btc, usd: price_usd, eur: price_eur });
                });
            } else {
                return callback(null, { btc: price_btc, usd: price_usd, eur: price_eur });
            }
        },
        function (callback) {
            let currentEfforts = {};
            for (let port in min_block_rewards) {
                const value = global.database.getCache(port != global.config.daemon.port ? "global_stats2_" + port : "global_stats2");
                if (value !== false) currentEfforts[port] = value.roundHashes;
            }
            return callback(null, currentEfforts);
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for pplns_port_shares value");
	    let pplns_port_shares = global.database.getCache('pplns_port_shares');
            return callback(null, pplns_port_shares ? pplns_port_shares : {});
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for pplns_window_time value");
	    let pplns_window_time = global.database.getCache('pplns_window_time');
            return callback(null, pplns_window_time ? pplns_window_time : 0);
        },
        function (callback) {
            //debug(threadName + "Checking Influx for last 5min avg for pool stats (hashRate) per port");
            return callback(null, port_hash || {});
        },
        function (callback) {
            //debug(threadName + "Checking LMDB cache for portMinerCount");
            return callback(null, global.database.getCache('portMinerCount') || {});
        },
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
            activePorts: result[12] || [],
            activePortProfit: result[13] || 0,
            coinProfit: result[14] || {},
            coinComment: result[15] || {},
            minBlockRewards: result[16] || {},
            pending: result[17] || 0,
            price: result[18] || {},
            currentEfforts: result[19] || {},
            pplnsPortShares: result[20] || {},
            pplnsWindowTime: result[21] || 0,
	    portHash: result[22] || {},
            portMinerCount: result[23] || {},
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

let prev_network_info = {};

function updateBlockHeader() {
    let info = {};

    let left = 0;
    for (let port in min_block_rewards) ++ left;

    for (let port in min_block_rewards) {
        global.coinFuncs.getPortLastBlockHeader(port, function(err, body){
            global.support.rpcPortDaemon(port,'get_info', [], function (rpcResult) {
                if (err !== null) {
                    console.error("Last block header request failed for " + port + " port!: " + (body instanceof Object ? JSON.stringify(body) : body));
                    if (port in prev_network_info) {
                        body.difficulty = prev_network_info[port].difficulty;
                        body.hash       = prev_network_info[port].hash;
                        body.height     = prev_network_info[port].height;
                        body.reward     = prev_network_info[port].value;
                        body.timestamp  = prev_network_info[port].ts;
                    } else {
                        body.difficulty = 0;
                        body.hash       = 0;
                        body.height     = 0;
                        body.reward     = 0;
                        body.timestamp  = 0;
                    }
                }
                prev_network_info[port] = info[port] = {
                    difficulty: body.difficulty,
                    hash:       body.hash,
                    height:     body.height,
                    value:      body.reward,
                    ts:         body.timestamp,
                };
                if (port == global.config.daemon.activePort) {
                        info.difficulty  = rpcResult.result ? rpcResult.result.difficulty : body.difficulty;
                        info.hash        = body.hash;
                        info.height      = body.height;
                        info.value       = body.reward;
                        info.ts          = body.timestamp;
                }
                if (-- left === 0) {
                    info.main_height = prev_network_info[global.config.daemon.port].height;
                    global.database.setCache('networkBlockInfo', info);
                }
            })
        }, true);    
    }
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
        global.coinFuncs.getPortLastBlockHeader(global.config.daemon.port, function (err, block) {
            if (err !== null){
                bad_header_start(port);
                return;
            }
            bad_header_stop();
            let top_height = 0;
            let is_master_daemon_issue = rows.length > 1 ? true : false;
            rows.forEach(function (row) {
                if (row.port && row.port != global.config.daemon.port) {
                    console.error("INTERNAL ERROR: pool node port " + row.port + " do not match master port " + global.config.daemon.port);
                    is_master_daemon_issue = false;
                    return;
                }
                if (top_height < row.blockID) top_height = row.blockID;
                if (Math.abs(block.height - row.blockID) > 3) {
                    global.support.sendEmail(global.config.general.adminEmail,
    			"Pool server behind in blocks",
			"The pool server: " + row.hostname + " with IP: " + row.ip + " is " + (block.height - row.blockID) + " blocks behind for " + port + " port"
		    );
                } else {
                    is_master_daemon_issue = false;
                }
            });
            if (is_master_daemon_issue) global.coinFuncs.fixDaemonIssue(block.height, top_height, global.config.daemon.port);
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
// clean stats_cache from time to time
setInterval(function() { stats_cache = {}; } , 4*60*60*1000);
