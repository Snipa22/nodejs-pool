"use strict";
let range = require('range');
let debug = require('debug')('db');
let async = require('async');

function Database(){
    this.lmdb = require('node-lmdb');
    this.env = null;
    this.shareDB = null;
    this.blockDB = null;
    this.cacheDB = null;
    this.roundhashes_reset_times = [];
    this.numWorkers = require('os').cpus().length;

    this.dirtyenv = false;

    this.initEnv = function(){
        global.database.env = new this.lmdb.Env();
        global.database.env.open({
            path: global.config.db_storage_path,
            maxDbs: 10,
            mapSize: 24 * 1024 * 1024 * 1024,
            noSync: false,
            mapAsync: false,
            useWritemap: false,
            noMetaSync: false,
            maxReaders: 512
        });
        global.database.shareDB = this.env.openDbi({
            name: 'shares',
            create: true,
            dupSort: true,
            dupFixed: false,
            integerDup: true,
            integerKey: true,
            keyIsUint32: true
        });
        global.database.blockDB = this.env.openDbi({
            name: 'blocks',
            create: true,
            integerKey: true,
            keyIsUint32: true
        });
        global.database.cacheDB = this.env.openDbi({
            name: 'cache',
            create: true
        });
        global.database.intervalID = setInterval(function(){
            global.database.env.sync(function(){});
        }, 60000);  // Sync the DB every 60 seconds
        global.database.dirtyenv = false;
        console.log("Database Worker: LMDB Env Initialized.");
    };

    // this computes worker thread specific cache key for safe updates
    this.worker_key = function(key) {
      if (this.hasOwnProperty("worker_id")) {
        return key + "_" + global.database.worker_id.toString();
      } else {
        console.error("No worker_id was assigned!!!");
        return key;
      }
    };

    this.incrementCacheData = function(key, data){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let cached = txn.getString(this.cacheDB, key);
        if (cached !== null){
            cached = JSON.parse(cached);
            data.forEach(function(intDict){
                if (!cached.hasOwnProperty(intDict.location) || intDict.value === false){
                    cached[intDict.location] = 0;
                } else {
                    cached[intDict.location] += intDict.value;
                }
            });
            txn.putString(this.cacheDB, key, JSON.stringify(cached));
            txn.commit();
        } else {
            txn.abort();
        }
    };

    this.incrementCacheDataPart = function(key, data){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let cached = txn.getString(this.cacheDB, global.database.worker_key(key));
        if (cached !== null){
            cached = JSON.parse(cached);
            let reset_time_string = txn.getString(this.cacheDB, key + '_roundhashes_reset_time');
            let reset_time = reset_time_string !== null ? parseInt(reset_time_string, 10) : 0;
            if (!this.roundhashes_reset_times.hasOwnProperty(key)) {
                console.error("Unknown key " + key + " for this.roundhashes_reset_times!!!");
            }
            data.forEach(function(intDict){
                if (intDict.location === 'roundHashes' && intDict.value === false) {
                    cached[intDict.location] = 0;
                    let time_now = Date.now();
                    this.roundhashes_reset_times[key] = time_now;
                    txn.putString(this.cacheDB, key + '_roundhashes_reset_time', time_now.toString());

                } else if (intDict.location === 'roundHashes' && this.roundhashes_reset_times[key] < reset_time) {
                    cached[intDict.location] = intDict.value;
                    this.roundhashes_reset_times[key] = reset_time;

                } else if (!cached.hasOwnProperty(intDict.location)) {
                    cached[intDict.location] = 0;

                } else {
                    cached[intDict.location] += intDict.value;
                }
            });
            txn.putString(this.cacheDB, global.database.worker_key(key), JSON.stringify(cached));
            txn.commit();
        } else {
            txn.abort();
        }
    };

    this.getBlockList = function(pool_type){
        debug("Getting block list");
        switch (pool_type) {
            case 'pplns':
                pool_type = global.protos.POOLTYPE.PPLNS;
                break;
            case 'pps':
                pool_type = global.protos.POOLTYPE.PPS;
                break;
            case 'solo':
                pool_type = global.protos.POOLTYPE.SOLO;
                break;
            default:
                pool_type = false;
        }
        let response = [];
        try{
            this.refreshEnv();
            let txn = global.database.env.beginTxn({readOnly: true});
            let cursor = new global.database.lmdb.Cursor(txn, global.database.blockDB);
            for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                /*
                 required string hash = 1;
                 required int64 difficulty = 2;
                 required int64 shares = 3;
                 required int64 timestamp = 4;
                 required POOLTYPE poolType = 5;
                 required bool unlocked = 6;
                 required bool valid = 7;
                 */
                cursor.getCurrentBinary(function (key, data) {  // jshint ignore:line
                    let blockData = global.protos.Block.decode(data);
                    let poolType;
                    switch (blockData.poolType){
                        case (global.protos.POOLTYPE.PPLNS):
                            poolType = 'pplns';
                            break;
                        case (global.protos.POOLTYPE.SOLO):
                            poolType = 'solo';
                            break;
                        case (global.protos.POOLTYPE.PPS):
                            poolType = 'pps';
                            break;
                        default:
                            poolType = 'Unknown';
                            break;
                    }
                    if (blockData.poolType === pool_type || pool_type === false) {
                        response.push({
                            ts: blockData.timestamp,
                            hash: blockData.hash,
                            diff: blockData.difficulty,
                            shares: blockData.shares,
                            height: key,
                            valid: blockData.valid,
                            unlocked: blockData.unlocked,
                            pool_type: poolType,
                            value: blockData.value
                        });
                    }
                });
            }
            cursor.close();
            txn.abort();
            return response.sort(global.support.blockCompare);
        } catch (e){
            return response;
        }
    };

    this.storeShare = function(blockId, shareData, callback){
        // This function needs the blockID in question, and the shareData in binary format.
        // The binary data should be packed as per the data.proto Share protobuf format.
        try {
            let share = global.protos.Share.decode(shareData);
            let minerID = share.paymentAddress;
            if (typeof(share.paymentID) !== 'undefined' && share.paymentID.length > 10) {
                minerID = minerID + '.' + share.paymentID;
            }
            let minerIDWithIdentifier = minerID + "_" + share.identifier;
            this.incrementCacheDataPart('global_stats', [{location: 'totalHashes', value: share.shares}, {location: 'roundHashes', value: share.shares}]);
            switch (share.poolType) {
                case global.protos.POOLTYPE.PPLNS:
                    this.incrementCacheDataPart('pplns_stats', [{location: 'totalHashes', value: share.shares}, {location: 'roundHashes', value: share.shares}]);
                    break;
                case global.protos.POOLTYPE.PPS:
                    this.incrementCacheDataPart('pps_stats', [{location: 'totalHashes', value: share.shares}, {location: 'roundHashes', value: share.shares}]);
                    break;
                case global.protos.POOLTYPE.SOLO:
                    this.incrementCacheDataPart('solo_stats', [{location: 'totalHashes', value: share.shares}, {location: 'roundHashes', value: share.shares}]);
                    break;
            }
            this.incrementCacheData(minerIDWithIdentifier, [{location: 'totalHashes', value: share.shares},{location: 'goodShares', value: 1}]);
            this.incrementCacheData(minerID, [{location: 'totalHashes', value: share.shares},{location: 'goodShares', value: 1}]);
        } catch (e){
            callback(false);
            return;
        }
        this.refreshEnv();
        let txn = this.env.beginTxn();
        txn.putBinary(this.shareDB, blockId, shareData);
        txn.commit();
        callback(true);
    };

    this.storeBulkShares = function(shareObject) {
        let cachedData = {
            global_stats: {totalHashes: 0, roundHashes: 0},
            pplns_stats: {totalHashes: 0, roundHashes: 0},
            pps_stats: {totalHashes: 0, roundHashes: 0},
            solo_stats: {totalHashes: 0, roundHashes: 0}
        };
        let shares = {};  // Shares keyed by blockID
        let shareCount = 0;
        debug(shareObject.length + ' shares to process');
        shareObject.forEach(function(share){
            //Data is the share object at this point.
            shareCount += 1;
            if (typeof(share.shares) === "number") {
                if (!shares.hasOwnProperty(share.blockHeight)) {
                    shares[share.blockHeight] = [];
                }
                shares[share.blockHeight].push(share);
                let minerID = share.paymentAddress;
                if (typeof(share.paymentID) !== 'undefined' && share.paymentID.length > 10) {
                    minerID = minerID + '.' + share.paymentID;
                }
                let minerIDWithIdentifier = minerID + "_" + share.identifier;
                cachedData.global_stats.totalHashes += share.shares;
                cachedData.global_stats.roundHashes += share.shares;
                let stats_type = 'pplns_stats';
                switch (share.poolType) {
                    case global.protos.POOLTYPE.PPLNS:
                        stats_type = 'pplns_stats';
                        break;
                    case global.protos.POOLTYPE.PPS:
                        stats_type = 'pps_stats';
                        break;
                    case global.protos.POOLTYPE.SOLO:
                        stats_type = 'solo_stats';
                        break;
                }
                cachedData[stats_type].totalHashes += share.shares;
                cachedData[stats_type].roundHashes += share.shares;
                if (!cachedData.hasOwnProperty(minerID)) {
                    cachedData[minerID] = {totalHashes: 0, goodShares: 0};
                }
                if (!cachedData.hasOwnProperty(minerIDWithIdentifier)) {
                    cachedData[minerIDWithIdentifier] = {totalHashes: 0, goodShares: 0};
                }
                cachedData[minerIDWithIdentifier].totalHashes += share.shares;
                cachedData[minerID].totalHashes += share.shares;
                cachedData[minerIDWithIdentifier].goodShares += 1;
                cachedData[minerID].goodShares += 1;
            } else {
                console.error("Error in share parser: " + JSON.stringify(share));
            }
            if(shareObject.length === shareCount){
                // Perform insert and return
                let inCache = 'notNull';
                while (inCache !== null){
                    let txn_ro = global.database.env.beginTxn({readOnly: true});
                    inCache = txn_ro.getString(global.database.cacheDB, 'cacheUpdate');
                    txn_ro.abort();
                }

                let txn = global.database.env.beginTxn();
                for (let key in cachedData){
                    if (cachedData.hasOwnProperty(key) && cachedData[key].totalHashes !== 0){
                        // only global cachedData stats has roundHashes
                        let key2 = cachedData[key].hasOwnProperty('roundHashes') ? global.database.worker_key(key) : key;
                        let cacheStore = txn.getString(global.database.cacheDB, key2);
                        if (cacheStore === null){
                            txn.putString(global.database.cacheDB, key2, JSON.stringify(cachedData[key]));
                        } else {
                            let json_cache = JSON.parse(cacheStore);
                            if (json_cache.hasOwnProperty('totalHashes')) { // cachedData.totalHashes is always there for global and miners stats 
                                json_cache.totalHashes += cachedData[key].totalHashes;
                            } else {
                                json_cache.totalHashes = cachedData[key].totalHashes;
                            }
                            if (cachedData[key].hasOwnProperty('goodShares')) {
                                if (json_cache.hasOwnProperty('goodShares')) {
                                    json_cache.goodShares += cachedData[key].goodShares;
                                } else {
                                    json_cache.goodShares = cachedData[key].goodShares;
                                }
                            } else if (cachedData[key].hasOwnProperty('roundHashes')) {
                                if (json_cache.hasOwnProperty('roundHashes')) {
                                    let reset_time_string = txn.getString(global.database.cacheDB, key + '_roundhashes_reset_time');
                                    let reset_time = reset_time_string !== null ? parseInt(reset_time_string, 10) : 0;
                                    if (!this.roundhashes_reset_times.hasOwnProperty(key)) {
                                        console.error("Unknown key " + key + " for this.roundhashes_reset_times!!!");
                                    }
                                    if (this.roundhashes_reset_times[key] < reset_time) {
                                        json_cache.roundHashes = cachedData[key].roundHashes;
                                        this.roundhashes_reset_times[key] = reset_time;
                                    } else {
                                        json_cache.roundHashes += cachedData[key].roundHashes;
                                    }
                                } else {
                                    json_cache.roundHashes = cachedData[key].roundHashes;
                                }
                            } else {
                                console.error("cachedData should have either goodShares or roundHashes!!!");
                            }
                            txn.putString(global.database.cacheDB, key2, JSON.stringify(json_cache));
                        }
                    }
                }
                let blocksSeen = 0;
                for (let key in shares){
                    if (shares.hasOwnProperty(key)){
                        blocksSeen += 1;
                        let sharesSeen = 0;
                        shares[key].forEach(function(final_share){  // jshint ignore:line
                            sharesSeen += 1;
                            try {
                                txn.putBinary(global.database.shareDB, parseInt(key), global.protos.Share.encode(final_share));
                            } catch (e) {
                                debug(final_share);
                            }
                            if (Object.keys(shares).length === blocksSeen && sharesSeen === shares[key].length){
                                debug('Made it to where I can do the insert');
                                txn.commit();
                                return true;
                            }
                        });
                    }
                }
            }
        });
        return false;
    };

    this.storeInvalidShare = function(shareData, callback){
        try {
            let share = global.protos.InvalidShare.decode(shareData);
            let minerID = share.paymentAddress;
            if (typeof(share.paymentID) !== 'undefined' && share.paymentID.length > 10) {
                minerID = minerID + '.' + share.paymentID;
            }
            let minerIDWithIdentifier = minerID + "_" + share.identifier;
            this.incrementCacheData(minerIDWithIdentifier, [{location: 'badShares', value: 1}]);
            this.incrementCacheData(minerID, [{location: 'badShares', value: 1}]);
            callback(true);
        } catch (e){
            console.error("Ran into an error string an invalid share.  Damn!");
            callback(false);
        }
    };

    this.getLastBlock = function(blockType){
        this.refreshEnv();
        debug("Getting the last block for: "+ blockType);
        let txn = this.env.beginTxn({readOnly: true});
        let cursor = new this.lmdb.Cursor(txn, this.blockDB);
        let highestBlock = 0;
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.Block.decode(data);
                if (blockData.poolType === blockType || typeof(blockType) === 'undefined'){
                    if (found > highestBlock){
                        highestBlock = found;
                    }
                }
            });
        }
        cursor.close();
        txn.commit();
        debug("Done getting the last block for: "+ blockType + " height of: "+ highestBlock);
        return highestBlock;
    };

    this.getBlockByID = function(blockID){
        this.refreshEnv();
        debug("Getting the data for blockID: " + blockID);
        let txn = this.env.beginTxn({readOnly: true});
        let data = txn.getBinary(this.blockDB, blockID);
        if (data === null){
            debug("Unable to get block at height: "+ blockID);
            return false;
        }
        let blockData = global.protos.Block.decode(data);
        txn.commit();
        debug("Done getting the last block for: "+ blockData.poolType + " height of: "+ blockID);
        return blockData;
    };

    this.calculateShares = function(blockData, blockHeight){
        debug("Calculating shares for "+ blockData.hash);
        this.refreshEnv();
        let lastBlock = this.getLastBlock(blockData.poolType);
        let shareCount = 0;
        range.range(lastBlock+1, blockHeight+1).forEach(function (blockID) {
            let txn = global.database.env.beginTxn({readOnly: true});
            let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
            for (let found = (cursor.goToRange(blockID) === blockID); found; found = cursor.goToNextDup()) {
                cursor.getCurrentBinary(function(key, data) {  // jshint ignore:line
                    try{
                        let shareData = global.protos.Share.decode(data);
                        if (shareData.poolType === blockData.poolType){
                            shareCount = shareCount + shareData.shares;
                        }
                    } catch(e){
                        console.error("Invalid share");
                    }
                });
            }
            cursor.close();
            txn.commit();
        });
        blockData.shares = shareCount;
        debug("Share calculator for "+ blockData.hash + " complete, found " + shareCount + " shares.");
        return global.protos.Block.encode(blockData);
    };

    this.storeBlock = function(blockId, blockData, callback){
        this.refreshEnv();
        try{
            let blockDataDecoded = global.protos.Block.decode(blockData);
            global.coinFuncs.getBlockHeaderByHash(blockDataDecoded.hash, function(err, header){
                if (err || typeof(header) === 'undefined' || !header){
                    return callback(false);
                }
                blockDataDecoded.value = header.reward;
                blockData = global.database.calculateShares(blockDataDecoded, blockId);
                let txn = global.database.env.beginTxn();
                txn.putBinary(global.database.blockDB, blockId, blockData);
                txn.commit();
                global.database.incrementCacheDataPart('global_stats', [{location: 'roundHashes', value: false}]);
                switch (blockDataDecoded.poolType) {
                    case global.protos.POOLTYPE.PPLNS:
                        global.database.incrementCacheDataPart('pplns_stats', [{location: 'roundHashes', value: false}]);
                        break;
                    case global.protos.POOLTYPE.PPS:
                        global.database.incrementCacheDataPart('pps_stats', [{location: 'roundHashes', value: false}]);
                        break;
                    case global.protos.POOLTYPE.SOLO:
                        global.database.incrementCacheDataPart('solo_stats', [{location: 'roundHashes', value: false}]);
                        break;
                }
                return callback(true);
            });
        } catch (e) {
            console.error("ERROR IN STORING BLOCK.  LOOK INTO ME PLZ: " + JSON.stringify(e));
            throw new Error("Error in block storage");
        }
    };

    this.fixBlockShares = function(blockId){
        let txn = global.database.env.beginTxn();
        let blockData = txn.getBinary(global.database.blockDB, blockId);
        txn.abort();
        let blockDataDecoded = global.protos.Block.decode(blockData);
        global.coinFuncs.getBlockHeaderByHash(blockDataDecoded.hash, function(err, header){
            if (err === null) {
                blockDataDecoded.value = header.reward;
                blockData = global.database.calculateShares(blockDataDecoded, blockId);
                let txn = global.database.env.beginTxn();
                txn.putBinary(global.database.blockDB, blockId, blockData);
                txn.commit();
            }
        });
    };

    this.invalidateBlock = function(blockId){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let blockData = global.protos.Block.decode(txn.getBinary(this.blockDB, blockId));
        blockData.valid = false;
        blockData.unlocked = true;
        txn.putBinary(this.blockDB, blockId, global.protos.Block.encode(blockData));
        txn.commit();
    };

    this.getValidLockedBlocks = function(){
        this.refreshEnv();
        let txn = this.env.beginTxn({readOnly: true});
        let cursor = new this.lmdb.Cursor(txn, this.blockDB);
        let blockList = [];
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.Block.decode(data);
                if (blockData.valid === true && blockData.unlocked === false){
                    blockData.height = key;
                    blockList.push(blockData);
                }
            });
        }
        cursor.close();
        txn.commit();
        return blockList;
    };

    this.unlockBlock = function(blockHex){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let cursor = new this.lmdb.Cursor(txn, this.blockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            let blockDB = this.blockDB;
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.Block.decode(data);
                if (blockData.hash === blockHex){
                    blockData.unlocked = true;
                    txn.putBinary(blockDB, key, global.protos.Block.encode(blockData));
                }
            });
            blockDB = null;
        }
        cursor.close();
        txn.commit();
    };

    this.lockBlock = function(blockId){
        let txn = this.env.beginTxn();
        let blockProto = txn.getBinary(this.blockDB, blockId);
        if (blockProto !== null){
            let blockData = global.protos.Block.decode(blockProto);
            blockData.unlocked = false;
            txn.putBinary(this.blockDB, blockId, global.protos.Block.encode(blockData));
        }
        txn.commit();
    };

    this.getCache = function(cacheKey){
        debug("Getting Key: "+cacheKey);
        try {
            this.refreshEnv();
            let txn = this.env.beginTxn({readOnly: true});
            let cached = txn.getString(this.cacheDB, cacheKey);
            txn.abort();
            if (cached !== null){
                debug("Result for Key: " + cacheKey + " is: " + cached);
                return JSON.parse(cached);
            }
        } catch (e) {
            return false;
        }
        return false;
    };

    this.getCacheSum = function(cacheKey){
        debug("Getting Key Sum: "+cacheKey);
        try {
            this.refreshEnv();
            let txn = this.env.beginTxn();
            let cached = txn.getString(this.cacheDB, cacheKey);
            if (cached !== null) {
                debug("Result for Key Sum: " + cacheKey + " is: " + cached);
                let json_cache = JSON.parse(cached);
                let totalHashes = 0;
                let roundHashes = 0;
                for (let i = 1; i <= this.numWorkers; ++ i) {
                    let cached2 = txn.getString(this.cacheDB, cacheKey + "_" + i.toString());
                    if (cached2 !== null) {
                        let json_cache2 = JSON.parse(cached2);
                        if (json_cache2.hasOwnProperty('totalHashes')) totalHashes += json_cache2.totalHashes;
                        else console.error("Key " + cacheKey + "_" + i.toString() + " does not have totalHashes!!!");
                        if (json_cache2.hasOwnProperty('roundHashes')) roundHashes += json_cache2.roundHashes;
                        else console.error("Key " + cacheKey + "_" + i.toString() + " does not have roundHashes!!!");
                    }
                }
                json_cache.totalHashes = totalHashes;
                json_cache.roundHashes = roundHashes;
                txn.putString(this.cacheDB, cacheKey, JSON.stringify(json_cache));
                txn.commit();
                return json_cache;
            }
            txn.abort();
        } catch (e) {
            return false;
        }
        return false;
    };

    this.setCache = function(cacheKey, cacheData){
        debug("Setting Key: "+cacheKey+ " Data: " + JSON.stringify(cacheData));
        this.refreshEnv();
        let txn = this.env.beginTxn();
        txn.putString(this.cacheDB, cacheKey, JSON.stringify(cacheData));
        txn.commit();
    };

    // this spits cache value into worker thread local value
    this.splitCache = function(cacheKey){
        debug("Splitting Key: "+cacheKey);
        let time_now = Date.now();
        this.roundhashes_reset_times[cacheKey] = time_now;
        try {
            this.refreshEnv();
            let txn = this.env.beginTxn();
            let cached = txn.getString(this.cacheDB, cacheKey);
            if (cached !== null){
                let json_cache = JSON.parse(cached);
                if (json_cache.hasOwnProperty('totalHashes')) json_cache.totalHashes /= this.numWorkers;
                else console.error("Key " + cacheKey + " does not have totalHashes!!!");
                if (json_cache.hasOwnProperty('roundHashes')) json_cache.roundHashes /= this.numWorkers;
                else console.error("Key " + cacheKey + " does not have roundHashes!!!");
                txn.putString(this.cacheDB, global.database.worker_key(cacheKey), JSON.stringify(json_cache));
                txn.putString(this.cacheDB, cacheKey + '_roundhashes_reset_time', '0');
                txn.commit();
            } else {
                txn.abort();
            }
        } catch (e) {
        }
    };

    this.bulkSetCache = function(cacheUpdates){
        let txn = this.env.beginTxn();
        txn.putString(this.cacheDB, 'cacheUpdate', 'cacheUpdate');
        txn.commit();
        txn = this.env.beginTxn();
        for (let key in cacheUpdates){
            if (cacheUpdates.hasOwnProperty(key)){
                txn.putString(this.cacheDB, key, JSON.stringify(cacheUpdates[key]));
            }
        }
        txn.del(this.cacheDB, 'cacheUpdate');
        txn.commit();
    };

    this.getOldestLockedBlock = function(){
        /*
        6-29-2017 - Snipa -
        This function returns a decompressed block proto for the first locked block in the system as part of the
        share depth functions.  DO NOT BLINDLY REPLACE getLastBlock WITH THIS FUNCTION.
        */
        this.refreshEnv();
        debug("Getting the oldest locked block in the system");
        let txn = this.env.beginTxn({readOnly: true});
        let cursor = new this.lmdb.Cursor(txn, this.blockDB);
        let highestBlock = null;
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            if (highestBlock !== null){
                break;
            }
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.Block.decode(data);
                if (blockData.unlocked === false){
                    highestBlock = blockData;
                }
            });
        }
        cursor.close();
        txn.commit();
        if (highestBlock !== null) {
            debug("Got the oldest locked block in the system at height: " + JSON.stringify(highestBlock));
        } else {
            debug("There are no unlocked blocks in the system.  Woohoo!");
        }
        return highestBlock;
    };

    this.cleanShareDB = function() {
        /*
         This function takes the difficulty of the current block, and the last PPS block.  If it's 0, save everything,
         UNLESS global.config.pps.enable is FALSE, then feel free to trash it.
         Due to LMDB under current config, we must delete entire keys, due to this, we save diff * shareMulti * 1.3
         6/29/2017 - Fixed bug with the way the system got blocks.  getLastBlock gets the most recent block.
         getOldestLockedBlock gets the oldest block in the system that's locked.  This ensures that shares for that block
         can't be destroyed, and that there's enough depth past that point to ensure the system will have the ability
         to make payouts based on the shareMultiLog.  Thanks suhz for finding this.  Sorry it hit your aeon pool hard.
         :( -- Snipa
         If current_height - global.payout.blocksRequired > lastLockedBlock, then set the scan start to
         current_height - global.payout.blocksRequired - 1 so that we have the full block in case of PPS.
         Otherwise, use the lastPPLNSBlock as the scan start.  There we go. Stupid logic!
         Math check!
         cur_height = 100, blocksRequired=20, lastPPLNSLockedBlock.height=90
         In this case, the functional depth required for SOLO is 80 - 1, giving us 79 as our start
         cur_height = 100, blocksRequired=20, lastPPLNSLockedBlock.height=70
         In this case, the PPLNS locked block is older than the current height - the required amount, so start is 70.
         PPS height no longer matters!  Yay!
         Solo really doesn't matter, as block finder gets everything.
         If there is no valid locked block to start from, aka all blocks are unlocked, then scan from the current height
         of the chain, as there's no way for the system to have older blocks.  We only need to save extra in the case
         where there's unlocked blocks.  A find on the current block will have enough depth as long as the saves are
         correct.  This will cause the system to clean up shares massively when there are no unlocked blocks.
         */
        let oldestLockedBlock = this.getOldestLockedBlock();
        async.waterfall([
            function(callback){
                if (oldestLockedBlock === null) {
                    callback(null, oldestLockedBlock)
                } else {
                    global.coinFuncs.getBlockHeaderByHash(oldestLockedBlock.hash, (err, result) => {
                        oldestLockedBlock.height = result.height;
                        console.log(`Got the oldest block`);
                        callback(null, oldestLockedBlock);
                    });
                }
             },
            function(oldestLockedBlock, callback){
                global.coinFuncs.getLastBlockHeader(function(err, body){
                    if (oldestLockedBlock === null){
                        /*
                        If there's no locked blocks, then allow the system to scan from the PPS depth downwards if PPS
                        is enabled.
                        Save enough shares so that the diff * share multi * 30% for buffer.
                         */
                        if (global.config.pps.enable){
                            // If PPS is enabled, we scan for new blocks at cur height - blocksRequired/2.
                            // We need to save shares back that far at the least.
                            callback(null, body.height - Math.floor(global.config.payout.blocksRequired/2), Math.floor(body.difficulty * global.config.pplns.shareMulti * 5));
                        } else {
                            // Otherwise, we can just start from the current height.  Woo!
                            callback(null, body.height, Math.floor(body.difficulty * global.config.pplns.shareMulti * 5));
                        }

                    } else {
                        /*
                        Otherwise, start the scan from the oldest locked block downwards.
                        This protects against the blockManager being messed up and not unlocking blocks.
                        This will ensure that enough shares are in place to unlock all blocks.
                        If the block is Solo, PPLNS or PPS, it doesn't matter.
                         */
                        if (global.config.pps.enable && oldestLockedBlock.height > body.height - Math.floor(global.config.payout.blocksRequired/2)) {
                            // If PPS is enabled, and the oldestLockedBlock.height > the PPS minimum, start from the PPS minimum.
                            callback(null, body.height - Math.floor(global.config.payout.blocksRequired/2), Math.floor(body.difficulty * global.config.pplns.shareMulti * 5));
                        } else {
                            // If PPS isn't enabled, or the oldestLockedBlock.height < the PPS minimum, then start from there.
                            callback(null, oldestLockedBlock.height, Math.floor(oldestLockedBlock.difficulty * global.config.pplns.shareMulti * 5));
                        }
                    }
                });
            },
            function (lastBlock, difficulty, callback) {
                let shareCount = 0;
                let pplnsFound = false;
                let blockList = [];
                console.log("Scanning from: "+lastBlock + " for more than: " + difficulty + " shares");
                range.range(0, lastBlock+1).forEach(function (blockID) {
                    blockID = (blockID - lastBlock+1) * -1;
                    if (blockID < 0){
                        return;
                    }
                    debug("Scanning block: " + blockID);
                    let txn = global.database.env.beginTxn({readOnly: true});
                    let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
                    for (let found = (cursor.goToRange(blockID) === blockID); found; found = cursor.goToNextDup()) {
                        if (pplnsFound){
                            cursor.getCurrentBinary(function(key, data) {  // jshint ignore:line
                                if (blockList.indexOf(key) === -1){
                                    blockList.push(key);
                                }
                            });
                        } else {
                            cursor.getCurrentBinary(function(key, data) {  // jshint ignore:line
                                try{
                                    let shareData = global.protos.Share.decode(data);
                                    if (shareData.poolType === global.protos.POOLTYPE.PPLNS){
                                        shareCount = shareCount + shareData.shares;
                                    }
                                } catch(e){
                                    console.error("Invalid share");
                                }
                            });
                            if (shareCount >= difficulty){
                                pplnsFound = true;
                            }
                        }
                    }
                    cursor.close();
                    txn.abort();
                });
                callback(null, blockList);
            }
        ], function(err, data){
            if (global.config.general.blockCleaner === true){
                if(data.length > 0){
                    global.database.refreshEnv();
                    let totalDeleted = 0;
                    data.forEach(function(block){
                        totalDeleted += 1;
                        let txn = global.database.env.beginTxn();
                        txn.del(global.database.shareDB, block);
                        txn.commit();
                        debug("Deleted block: " + block);
                    });
                    console.log("Block cleaning enabled.  Removed: " +totalDeleted+ " block share records");
                }
                global.database.env.sync(function(){
                });
            } else {
                console.log("Block cleaning disabled.  Would have removed: " + JSON.stringify(data));
            }
        });
    };

    this.refreshEnv = function(){};

    setInterval(function(){
        global.database.dirtyenv = true;
    }, 900000);  // Set DB env reload for every 15 minutes.
}

module.exports = Database;
