'use strict';
const debug = require('debug')('pool_stats');
const async = require('async');
const { aux } = require('./common');

const threadName = 'Worker Server ';
const max_blocks = 1000;
const max_altblocks = 10000;

let lastBlockCheckIsFailed = {};

let price_btc = 0;
let price_usd = 0;
let price_eur = 0;
let min_block_rewards = {};
let blockList = [];
let altblockList = [];
let altblockFound = {};
let altblockFoundDone = 0;

function get_cmc_price(symbol, callback) {
    const slug = global.config.coin.name.toLowerCase();
    global.support.https_get(
        'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?slug=' +
            slug +
            '&convert=' +
            symbol +
            '&CMC_PRO_API_KEY=' +
            global.config.general.cmcKey,
        function (res) {
            if (
                res instanceof Object &&
                'data' in res &&
                'quote' in res.data[Object.keys(res.data)[0]] &&
                symbol in res.data[Object.keys(res.data)[0]].quote
            ) {
                return callback(parseFloat(res.data[Object.keys(res.data)[0]].quote[symbol].price));
            } else {
                console.error("Can't get price data from: " + JSON.stringify(res));
                return callback(0);
            }
        },
    );
}

function get_cmc(callback) {
    get_cmc_price('USD', function (usd) {
        get_cmc_price('EUR', function (eur) {
            get_cmc_price('BTC', function (btc) {
                price_btc = btc ? btc : price_btc;
                price_usd = usd ? usd : price_usd;
                price_eur = eur ? eur : price_eur;
                return callback({ btc: price_btc, usd: price_usd, eur: price_eur });
            });
        });
    });
}

function updatePoolStats(poolType) {
    //console.log("Cleaned " + global.database.env.mdb_reader_check() + " stale readers");
    let cache;
    if (typeof poolType !== 'undefined') {
        cache = global.database.getCache(poolType + '_stats') || {};
        let cache2 = global.database.getCache(poolType + '_stats2') || {};
        cache.totalHashes = cache2.totalHashes;
        cache.roundHashes = cache2.roundHashes;
    } else {
        console.log('Running pool stats');
        cache = global.database.getCache('global_stats') || {};
        let cache2 = global.database.getCache('global_stats2') || {};
        cache.totalHashes = cache2.totalHashes;
        cache.roundHashes = cache2.roundHashes;
    }

    let port_hash = global.database.getCache('port_hash');
    if (blockList.length > max_blocks) {
        const newBlocks = global.database.getBlockList(poolType, 0, max_blocks);
        let new_block_count = 0;
        let prev_block_index = 0;
        for (let block of newBlocks) {
            if (block.hash == blockList[prev_block_index].hash) ++prev_block_index;
            else ++new_block_count;
        }
        blockList = newBlocks.concat(blockList.slice(max_blocks - new_block_count));
    } else {
        blockList = global.database.getBlockList(poolType);
    }
    if (altblockList.length > max_altblocks) {
        const newBlocks = global.database.getAltBlockList(poolType, null, 0, max_altblocks);
        let new_block_count = 0;
        let prev_block_index = 0;
        for (let block of newBlocks) {
            if (block.hash == altblockList[prev_block_index].hash) ++prev_block_index;
            else ++new_block_count;
        }
        altblockList = newBlocks.concat(altblockList.slice(max_altblocks - new_block_count));
    } else {
        altblockList = global.database.getAltBlockList(poolType);
    }
    let min_block_rewards2 = global.database.getCache('min_block_rewards');
    if (min_block_rewards2) min_block_rewards = min_block_rewards2;
    if (!(global.config.daemon.port in min_block_rewards)) min_block_rewards[global.config.daemon.port] = 0;

    async.series(
        [
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
                if (typeof poolType !== 'undefined') {
                    global.mysql
                        .query(
                            'SELECT payment_address, payment_id FROM payments WHERE pool_type = ? group by payment_address, payment_id',
                            [poolType],
                        )
                        .then(function (rows) {
                            return callback(null, rows.length);
                        });
                } else {
                    global.mysql
                        .query('SELECT payment_address, payment_id FROM payments group by payment_address, payment_id')
                        .then(function (rows) {
                            return callback(null, rows.length);
                        });
                }
            },
            function (callback) {
                //debug(threadName + "Checking MySQL for total transactions count");
                if (typeof poolType !== 'undefined') {
                    global.mysql
                        .query('SELECT distinct(transaction_id) from payments WHERE pool_type = ?', [poolType])
                        .then(function (rows) {
                            return callback(null, rows.length);
                        });
                } else {
                    global.mysql.query('SELECT count(id) as txn_count FROM transactions').then(function (rows) {
                        if (typeof rows[0] !== 'undefined') {
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
                for (let i in altblockList) {
                    if (i >= altblockList.length - altblockFoundDone) break;
                    let block = altblockList[i];
                    if (altblockFound.hasOwnProperty(block.port)) ++altblockFound[block.port];
                    else altblockFound[block.port] = 1;
                }
                altblockFoundDone = altblockList.length;
                return callback(null, altblockFound);
            },
            function (callback) {
                //debug(threadName + "Checking MySQL for activePort value");
                return callback(null, global.config.daemon.port);
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
                    if (i > max_blocks) break;
                    const block = blockList[i];
                    if (block.valid === true && block.unlocked === false)
                        pending += global.support.coinToDecimal(block.value, block.coin);
                }
                for (let i in altblockList) {
                    if (i > max_altblocks) break;
                    const altblock = altblockList[i];
                    if (altblock.valid === true && altblock.unlocked === false)
                        pending += altblock.port in min_block_rewards ? min_block_rewards[altblock.port] : 0;
                }
                return callback(null, pending);
            },
            function (callback) {
                if (typeof poolType === 'undefined' && price_btc == 0 && price_usd == 0 && price_eur == 0) {
                    return get_cmc(function (prices) {
                        return callback(null, prices);
                    });
                } else return callback(null, { btc: price_btc, usd: price_usd, eur: price_eur });
            },
            function (callback) {
                const value = global.database.getCache('global_stats2');
                return callback(null, value ? value.roundHashes : 0);
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
        ],
        function (err, result) {
            global.database.setCache('pool_stats_' + (typeof poolType === 'undefined' ? 'global' : poolType), {
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
                currentEfforts: result[19] || 0,
                pplnsPortShares: result[20] || {},
                pplnsWindowTime: result[21] || 0,
                portHash: result[22] || {},
                portMinerCount: result[23] || {},
            });
            setTimeout(updatePoolStats, 30 * 1000, poolType);
        },
    );
}

function updatePoolPorts(poolServers) {
    //debug(threadName + "Updating pool ports");
    let local_cache = { global: [] };
    let portCount = 0;
    global.mysql
        .query('select * from ports where hidden = 0 and pool_id < 1000 and lastSeen >= NOW() - INTERVAL 10 MINUTE')
        .then(function (rows) {
            rows.forEach(function (row) {
                ++portCount;
                if (!local_cache.hasOwnProperty(row.port_type)) {
                    local_cache[row.port_type] = [];
                }
                local_cache[row.port_type].push({
                    host: poolServers[row.pool_id],
                    port: row.network_port,
                    difficulty: row.starting_diff,
                    description: row.description,
                    miners: row.miners,
                });
                if (portCount === rows.length) {
                    let local_counts = {};
                    let port_diff = {};
                    let port_miners = {};
                    let pool_type_count = 0;
                    let localPortInfo = {};
                    for (let pool_type in local_cache) {
                        // jshint ignore:line
                        ++pool_type_count;
                        local_cache[pool_type].forEach(function (portData) {
                            // jshint ignore:line
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
                                ++local_counts[portData.port];
                                port_miners[portData.port] += portData.miners;
                            }
                            localPortInfo[portData.port] = portData.description;
                            if (local_counts[portData.port] === Object.keys(poolServers).length) {
                                local_cache.global.push({
                                    host: {
                                        blockID:
                                            typeof local_cache[pool_type][0].host === 'undefined'
                                                ? 0
                                                : local_cache[pool_type][0].host.blockID,
                                        blockIDTime:
                                            typeof local_cache[pool_type][0].host === 'undefined'
                                                ? 0
                                                : local_cache[pool_type][0].host.blockIDTime,
                                        hostname: global.config.pool.geoDNS,
                                    },
                                    port: portData.port,
                                    pool_type: pool_type,
                                    difficulty: portData.difficulty,
                                    miners: port_miners[portData.port],
                                    description: localPortInfo[portData.port],
                                });
                            }
                        });
                        if (pool_type_count === Object.keys(local_cache).length) {
                            //debug(threadName + "Sending the following to the workers: " + JSON.stringify(local_cache));
                            global.database.setCache('poolPorts', local_cache);
                            setTimeout(updatePoolInformation, 30 * 1000);
                        }
                    }
                }
            });
        });
}

function updatePoolInformation() {
    let local_cache = {};
    //debug(threadName + "Updating pool information");
    global.mysql
        .query('select * from pools where id < 1000 and last_checkin >= NOW() - INTERVAL 10 MINUTE')
        .then(function (rows) {
            rows.forEach(function (row) {
                local_cache[row.id] = {
                    ip: row.ip,
                    blockID: row.blockID,
                    blockIDTime: global.support.formatDateFromSQL(row.blockIDTime),
                    hostname: row.hostname,
                };
                if (Object.keys(local_cache).length === rows.length) {
                    global.database.setCache('poolServers', local_cache);
                    updatePoolPorts(local_cache);
                }
            });
        });
}

let network_info = {};

function updateBlockHeader() {
    global.coinFuncs.getLastBlockHeader(function (err, body) {
        if (err) {
            console.error(err);
            return;
        }

        const header = body.block_header;
        const auxData = aux.getAllAuxChainData(body);
        const networkInfo = {
            difficulty: header.difficulty,
            hash: header.hash ? header.hash : header.hashrate,
            height: header.height,
            value: header.reward,
            ts: header.timestamp,
            auxChains: auxData,
        };

        global.support.rpcDaemon('get_info', [], function (err, rpcResult) {
            if (err) {
                console.error(err);
                return;
            }
            networkInfo.difficulty = rpcResult.result ? rpcResult.result.difficulty : body.difficulty;

            global.database.setCache('networkBlockInfo', networkInfo);
            setTimeout(updateBlockHeader, 30 * 1000);
        });
    }, true);
}

function bad_header_start(port) {
    console.error('Issue in getting block header for ' + port + ' port. Skipping node monitor');
    if (port in lastBlockCheckIsFailed) {
        if (++lastBlockCheckIsFailed[port] >= 5)
            global.support.sendEmail(
                global.config.general.adminEmail,
                'Failed to query daemon for ' + port + ' port for last block header',
                `The worker failed to return last block header for ` +
                    port +
                    ` port. Please verify if the daemon is running properly.`,
            );
    } else {
        lastBlockCheckIsFailed[port] = 1;
    }
    return;
}

function bad_header_stop(port) {
    if (port in lastBlockCheckIsFailed) {
        if (lastBlockCheckIsFailed[port] >= 5)
            global.support.sendEmail(
                global.config.general.adminEmail,
                'Quering daemon for ' + port + ' port for last block header is back to normal',
                `An warning was sent to you indicating that the the worker failed to return the last block header for ${port} port.
             The issue seems to be solved now.`,
            );
        delete lastBlockCheckIsFailed[port];
    }
}

function monitorNodes() {
    global.mysql
        .query('SELECT blockID, hostname, ip, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)')
        .then(function (rows) {
            global.coinFuncs.getLastBlockHeader(function (err, block) {
                if (err !== null) {
                    bad_header_start(global.config.daemon.port);
                    return;
                }
                bad_header_stop();
                let top_height = 0;
                let is_master_daemon_issue = rows.length > 1;
                rows.forEach(function (row) {
                    if (row.port && row.port != global.config.daemon.port) {
                        console.error(
                            'INTERNAL ERROR: pool node port ' +
                                row.port +
                                ' do not match master port ' +
                                global.config.daemon.port,
                        );
                        is_master_daemon_issue = false;
                        return;
                    }
                    if (top_height < row.blockID) top_height = row.blockID;
                    if (Math.abs(block.height - row.blockID) > 3) {
                        global.support.sendEmail(
                            global.config.general.adminEmail,
                            'Pool server behind in blocks',
                            'The pool server: ' +
                                row.hostname +
                                ' with IP: ' +
                                row.ip +
                                ' is ' +
                                (block.height - row.blockID) +
                                ' blocks behind for ' +
                                row.port +
                                ' port',
                        );
                    } else {
                        is_master_daemon_issue = false;
                    }
                });
                if (is_master_daemon_issue)
                    global.coinFuncs.fixDaemonIssue(block.height, top_height, global.config.daemon.port);
            });
        });
}

updatePoolStats();
updatePoolStats('pplns');
if (global.config.pps.enable === true) updatePoolStats('pps');
if (global.config.solo.enable === true) updatePoolStats('solo');
updatePoolInformation();
updateBlockHeader();

monitorNodes();
setInterval(monitorNodes, 5 * 60 * 1000);
setInterval(get_cmc, 15 * 60 * 1000, function () {});
