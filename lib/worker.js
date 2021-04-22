"use strict";
const debug   = require("debug")("worker");
const sprintf = require("sprintf-js").sprintf;

let cycleCount = 0;
let hashrate_avg_min = 10;
let stat_change_alert = 0.3;

let prev_pool_state_time;
let prev_pool_hashrate;
let prev_pool_workers;

let stats_cache = {};
let miner_history_update_time = {};

let pool_type_str = {};
pool_type_str[global.protos.POOLTYPE.PPLNS] = 'pplns';
pool_type_str[global.protos.POOLTYPE.PPS]   = 'pps';
pool_type_str[global.protos.POOLTYPE.SOLO]  = 'solo';

let identifiers     = {};
let minerSet        = {};
let minerPortSet    = {};
let localMinerCount = {};
let localStats      = {};
let localPortHashes = {};
let localTimes      = {};

let prevMinerSet    = {};
let cache_updates   = {};
let portMinerCount  = {};

function updateShareStats2(height, callback) {
    // This is an omni-worker to deal with all things share-stats related
    // Time based averages are worked out on ring buffers.
    // Buffer lengths?  You guessed it, configured in SQL.
    // Stats timeouts are 30 seconds, so everything for buffers should be there.
    const currentTime = Date.now();
    // power to ensure we can keep up to global.config.general.statsBufferHours in global.config.general.statsBufferLength array
    // here N = log(history_power, global.config.general.statsBufferLength) is number of attemps required on average to remove top left history point (the oldest one)
    // we just select history_power so that is till happen on global.config.general.statsBufferHours * 60 attemps on average
    const history_power = Math.log(global.config.general.statsBufferLength) / Math.log(global.config.general.statsBufferHours * 60);

    console.log("Starting stats collection for " + height + " height (history power: " + history_power + ")");

    const locTime = currentTime - (hashrate_avg_min*60*1000);
    const identifierTime = currentTime - (2*hashrate_avg_min*60*1000);

    let minerCount = 0;

    identifiers = {};
    minerSet = {};
    minerPortSet = {};
    localMinerCount = { pplns: 0, pps: 0, solo: 0, prop: 0, global: 0 };
    localStats = { pplns: 0, pps: 0, solo: 0, prop: 0, global: 0, miners: {}, miners2: {} };
    localPortHashes = {};
    localTimes = { pplns: locTime, pps: locTime, solo: locTime, prop: locTime, global: locTime, miners: {} };

    let loopBreakout = 0;
    let oldestTime = currentTime;
    let txn = global.database.env.beginTxn({readOnly: true});
    let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);

    do {
        let count = 0;
        for (let found = cursor.goToRange(height) === height; found; ++ count, found = cursor.goToNextDup()) cursor.getCurrentBinary(function (key, share) {  // jshint ignore:line
            try {
                share = global.protos.Share.decode(share);
            } catch (e) {
                console.error(share);
                return;
            }
            if (share.timestamp < oldestTime) oldestTime = share.timestamp;
            if (share.timestamp <= identifierTime) return;

            const minerID = typeof(share.paymentID) !== 'undefined' && share.paymentID.length > 10
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

            const minerIDWithIdentifier = minerID + "_" + identifier;
            const shares2 = share.shares2;
            localStats.global += shares2;
            if (localTimes.global < share.timestamp) localTimes.global = share.timestamp;
            const minerType = pool_type_str[share.poolType];
            if (!minerType) {
                console.error("Wrong share pool type found: " + share.poolType);
                return;
            }
            localStats[minerType] += shares2;
            if (localTimes[minerType] < share.timestamp) localTimes[minerType] = share.timestamp;

            const port = typeof(share.port) !== 'undefined' && share.port ? share.port : global.config.daemon.port;
            if (port in localPortHashes) localPortHashes[port] += share.raw_shares;
            else localPortHashes[port] = share.raw_shares;

            if (!shares2) return; // use virtual shares from child block mining only for global pool stats

            if (minerID in minerPortSet) {
                localStats.miners[minerID]  += share.raw_shares;
                localStats.miners2[minerID] += shares2;
                if (localTimes.miners[minerID] < share.timestamp) localTimes.miners[minerID] = share.timestamp;
            } else {
                ++ localMinerCount[minerType];
                ++ localMinerCount.global;
                localStats.miners[minerID]  = share.raw_shares;
                localStats.miners2[minerID] = shares2;
                localTimes.miners[minerID]  = share.timestamp;
                minerSet[minerID] = 1;
                minerPortSet[minerID] = port;
            }

            if (minerIDWithIdentifier in minerSet) {
                localStats.miners[minerIDWithIdentifier]  += share.raw_shares;
                localStats.miners2[minerIDWithIdentifier] += shares2;
                if (localTimes.miners[minerIDWithIdentifier] < share.timestamp) localTimes.miners[minerIDWithIdentifier] = share.timestamp;
            } else {
                localStats.miners[minerIDWithIdentifier]  = share.raw_shares;
                localStats.miners2[minerIDWithIdentifier] = shares2;
                localTimes.miners[minerIDWithIdentifier]  = share.timestamp;
                minerSet[minerIDWithIdentifier] = 1;
            }
        });
        debug("On " + height + " height iterated " + count + " elements");
    } while (++loopBreakout <= 60 && --height >= 0 && oldestTime > identifierTime);
    cursor.close();
    txn.abort();

    debug("Share loop: " + ((Date.now() - currentTime) / 1000) + " seconds");
    prevMinerSet = global.database.getCache('minerSet');
    if (prevMinerSet === false) prevMinerSet = minerSet;
    cache_updates = {};
    // pplns: 0, pps: 0, solo: 0, prop: 0, global: 0
    ['pplns', 'pps', 'solo', 'prop', 'global'].forEach(function (key) {
        const hash       = localStats[key] / (hashrate_avg_min*60);
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
    for (let port in localPortHashes) localPortHashes[port] = localPortHashes[port] / (hashrate_avg_min*60);
    cache_updates["port_hash"] = localPortHashes;
    let history_update_count = 0;

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

        stats.hash  = localStats.miners[miner]  / (hashrate_avg_min*60);
        stats.hash2 = localStats.miners2[miner] / (hashrate_avg_min*60);
        stats.lastHash = localTimes.miners[miner];
        cache_updates[keyStats] = { hash: stats.hash, hash2: stats.hash2, lastHash: stats.lastHash };

        if (cycleCount === 0) {
            stats.hashHistory.unshift({ts: currentTime, hs: stats.hash, hs2: stats.hash2});
            if (stats.hashHistory.length > global.config.general.statsBufferLength) {
                const is_worker = miner.indexOf('_') >= 0;
                while (stats.hashHistory.length > global.config.general.statsBufferLength) {
                    if (is_worker) {
                        stats.hashHistory.pop();
                    } else {
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
            }
	if ( stats.hashHistory.length < global.config.general.statsBufferLength ||
                 !(miner in miner_history_update_time) ||
                 (history_update_count < 5000 && currentTime - miner_history_update_time[miner] > 10*60*1000)
               ) {
                cache_updates[keyHistory] = { hashHistory: stats.hashHistory };
                miner_history_update_time[miner] = currentTime;
                ++ history_update_count;
            }
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
        const address_parts = miner.split(/_(.+)/);
        const worker = address_parts[1];
        if (typeof(worker) !== 'undefined' && !worker.includes('silent')) {
            if (!(miner in workers_stopped_hashing_time)) {
                workers_stopped_hashing_time[miner] = currentTime;
                setTimeout(delayed_send_worker_stopped_hashing_email, 10*60*1000, miner, currentTime);
            }
        }
    }

    debug("Old worker loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

    // find new workers
    for (let miner in minerSet) {
        if (miner in prevMinerSet) continue; // we still have this miner in previous set
        //debug("Adding: " + miner + " as an active miner to the cache.");
        if (miner.indexOf('_') <= -1) continue;

        // This is a worker case.
        const address_parts = miner.split(/_(.+)/);
        const worker = address_parts[1];
        if (typeof(worker) !== 'undefined' && !worker.includes('silent')) {
            workers_started_hashing_time[miner] = currentTime;
            if (miner in workers_stopped_hashing_email_time) {
                delete workers_stopped_hashing_time[miner];
                delete workers_stopped_hashing_email_time[miner];
                const address = address_parts[0];
                get_address_email(address, function (email) {
                    send_worker_started_hashing_email(miner, email, currentTime);
                });
            }
        }
    }

    debug("New worker loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

    Object.keys(identifiers).forEach(function (key) {
        cache_updates['identifiers:' + key] = identifiers[key];
    });

    portMinerCount = {};
    for (let miner in minerPortSet) {
        const port = minerPortSet[miner];
        if (port in portMinerCount) ++ portMinerCount[port];
        else portMinerCount[port] = 1;
    }
    cache_updates.portMinerCount = portMinerCount;
    cache_updates.minerSet = minerSet;
    const db_write_start_time = Date.now();
    try {
        global.database.bulkSetCache(cache_updates);
    } catch (e) {
        console.error("Can't write to pool DB: " + e);
        global.support.sendEmail(global.config.general.adminEmail, "FYI: Pool DB is overflowed!", "Can't wite to pool DB: " + e);
    }
    cache_updates = {};

    let pool_hashrate = localStats.global / (hashrate_avg_min*60);
    let pool_workers  = minerCount;
    console.log("Processed " + minerCount + " workers (" + history_update_count + " history) for " +
        ((Date.now() - currentTime) / 1000) + " seconds (" + ((Date.now() - db_write_start_time) / 1000) + " seconds DB write). " +
        "Pool hashrate is: " + pool_hashrate
    );
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
    return callback();
}
         
function updateShareStats() {
    global.coinFuncs.getLastBlockHeader(function (err, body) {
        if (err !== null){
            return setTimeout(updateShareStats, 10*1000);
        }
        updateShareStats2(body.height + 1, function() {
            if (++cycleCount === 3) cycleCount = 0;
            setTimeout(updateShareStats, 10*1000);
        });
    });
}

// cached email of specific address
let minerEmail = {};
// time of last SQL check for specific address
let minerEmailTime = {};

// worker name -> time
let workers_started_hashing_time = {};
let workers_stopped_hashing_time = {};
let workers_stopped_hashing_email_time = {};

function get_address_email(address, callback) {
    let currentTime = Date.now();
    if (!(address in minerEmailTime) || currentTime - minerEmailTime[address] > 10*60*1000) {
        minerEmailTime[address] = currentTime;
        minerEmail[address] = null;
        global.mysql.query("SELECT email FROM users WHERE username = ? AND enable_email IS true limit 1", [address]).then(function (rows) {
            if (rows.length === 0) {
                delete minerEmail[address];
                return;
            } else {
                minerEmail[address] = rows[0].email;
            }
            return callback(minerEmail[address]);
        }).catch(function (error) {
            console.error("Can't get email address for " + address + ": " + error.message);
            return;
        });
    } else if (address in minerEmail) {
        if (minerEmail[address] === null) { // not yet ready (retry again in 10 secs)
            if (currentTime - minerEmailTime[address] < 5*1000) return setTimeout(get_address_email, 10*1000, address, callback);
        } else {
            return callback(minerEmail[address]);
        }
    }
}

function send_worker_started_hashing_email(miner, email, currentTime) {
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

function delayed_send_worker_stopped_hashing_email(miner, currentTime) {
    if (miner in workers_started_hashing_time && Date.now() - workers_started_hashing_time[miner] <= 10*60*1000) {
        delete workers_started_hashing_time[miner];
        return;
    }

    delete workers_started_hashing_time[miner];

    const address_parts = miner.split(/_(.+)/);
    const address = address_parts[0];

    get_address_email(address, function (email) {
        workers_stopped_hashing_email_time[miner] = Date.now();
        const worker  = address_parts[1];

        // toAddress, subject, body
        const emailData = {
            worker: worker,
            timestamp: global.support.formatDate(currentTime),
            poolEmailSig: global.config.general.emailSig
        };
        global.support.sendEmail(email,
            sprintf(global.config.email.workerNotHashingSubject, emailData),
            sprintf(global.config.email.workerNotHashingBody,    emailData),
            address
        );
    });
}


global.support.sendEmail(global.config.general.adminEmail, "Restarting worker module", "Restarted worker module!");

updateShareStats();
// clean caches from time to time
setInterval(function() {
    console.log("Cleaning caches (" + Object.keys(stats_cache).length + " stats, " + Object.keys(miner_history_update_time).length + " histories)");
    const currentTime = Date.now();
    let stats_cache2 = {};
    for (let miner in stats_cache) {
        if (miner in miner_history_update_time && currentTime - miner_history_update_time[miner] < 60*60*1000) {
            stats_cache2[miner] = stats_cache[miner];
        }
    }
    stats_cache = stats_cache2;
    console.log("After cleaning: " + Object.keys(stats_cache).length + " stats left");
    miner_history_update_time = {};
}, 2*60*60*1000);
