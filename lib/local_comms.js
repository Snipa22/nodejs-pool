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

    this.dirtyenv = false;

    this.initEnv = function(){
        global.database.env = new this.lmdb.Env();
        global.database.env.open({
            path: global.config.db_storage_path,
            maxDbs: 10,
            mapSize: 24 * 1024 * 1024 * 1024,
            noSync: false,
            mapAsync: true,
            useWritemap: false,
            noMetaSync: true,
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


    this.incrementCacheData = function(key, data){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let cached = txn.getString(this.cacheDB, key);
        if (cached !== null){
            cached = JSON.parse(cached);
            data.forEach(function(intDict){
                if (!cached.hasOwnProperty(intDict.location)){
                    cached[intDict.location] = 0;
                }
                if (intDict.value === false){
                    cached[intDict.location] = 0;
                } else {
                    cached[intDict.location] += intDict.value;
                }
            });
            txn.putString(this.cacheDB, key, JSON.stringify(cached));
            txn.commit();
            return;
        }
        txn.abort();
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
            this.incrementCacheData('global_stats', [{location: 'totalHashes', value: share.shares}, {location: 'roundHashes', value: share.shares}]);
            switch (share.poolType) {
                case global.protos.POOLTYPE.PPLNS:
                    this.incrementCacheData('pplns_stats', [{location: 'totalHashes', value: share.shares}, {location: 'roundHashes', value: share.shares}]);
                    break;
                case global.protos.POOLTYPE.PPS:
                    this.incrementCacheData('pps_stats', [{location: 'totalHashes', value: share.shares}, {location: 'roundHashes', value: share.shares}]);
                    break;
                case global.protos.POOLTYPE.SOLO:
                    this.incrementCacheData('solo_stats', [{location: 'totalHashes', value: share.shares}, {location: 'roundHashes', value: share.shares}]);
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
            global_stats: global.database.getCache('global_stats'),
            pplns_stats: global.database.getCache('pplns_stats'),
            pps_stats: global.database.getCache('pps_stats'),
            solo_stats: global.database.getCache('solo_stats')
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
                // this.incrementCacheData('global_stats', [{location: 'totalHashes', value: share.shares}, {location: 'roundHashes', value: share.shares}]);
                if (!cachedData.global_stats.hasOwnProperty('totalHashes') || cachedData.global_stats.totalHashes === null) {
                    cachedData.global_stats.totalHashes = 0;
                }
                if (!cachedData.global_stats.hasOwnProperty('roundHashes') || cachedData.global_stats.roundHashes === null || share.foundBlock) {
                    cachedData.global_stats.roundHashes = 0;
                }
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
                if (!cachedData[stats_type].hasOwnProperty('totalHashes') || cachedData[stats_type].totalHashes === null) {
                    cachedData[stats_type].totalHashes = 0;
                }
                if (!cachedData[stats_type].hasOwnProperty('roundHashes') || cachedData[stats_type].roundHashes === null || share.foundBlock) {
                    cachedData[stats_type].roundHashes = 0;
                }
                cachedData[stats_type].totalHashes += share.shares;
                cachedData[stats_type].roundHashes += share.shares;
                if (!cachedData.hasOwnProperty(minerID)) {
                    let minerCache = global.database.getCache(minerID);
                    if (minerCache === false) {
                        minerCache = {totalHashes: 0, goodShares: 0};
                    }
                    cachedData[minerID] = minerCache;
                }
                if (!cachedData.hasOwnProperty(minerIDWithIdentifier)) {
                    let minerCache = global.database.getCache(minerIDWithIdentifier);
                    if (minerCache === false) {
                        minerCache = {totalHashes: 0, goodShares: 0};
                    }
                    cachedData[minerIDWithIdentifier] = minerCache;
                }
                if (!cachedData[minerIDWithIdentifier].hasOwnProperty('totalHashes') || cachedData[minerIDWithIdentifier].totalHashes === null) {
                    cachedData[minerIDWithIdentifier].totalHashes = 0;
                }
                if (!cachedData[minerIDWithIdentifier].hasOwnProperty('goodShares') || cachedData[minerIDWithIdentifier].goodShares === null) {
                    cachedData[minerIDWithIdentifier].goodShares = 0;
                }
                if (!cachedData[minerID].hasOwnProperty('totalHashes') || cachedData[minerID].totalHashes === null) {
                    cachedData[minerID].totalHashes = 0;
                }
                if (!cachedData[minerID].hasOwnProperty('goodShares') || cachedData[minerID].goodShares === null) {
                    cachedData[minerID].goodShares = 0;
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
                let txn = global.database.env.beginTxn();
                for (let key in cachedData){
                    if (cachedData.hasOwnProperty(key)){
                        txn.putString(global.database.cacheDB, key, JSON.stringify(cachedData[key]));
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
            global.coinFuncs.getBlockHeaderByHash(blockDataDecoded.hash, function(header){
                if (typeof(header) === 'undefined' || !header){
                    return callback(false);
                }
                blockDataDecoded.value = header.reward;
                blockData = global.database.calculateShares(blockDataDecoded, blockId);
                let txn = global.database.env.beginTxn();
                txn.putBinary(global.database.blockDB, blockId, blockData);
                txn.commit();
                global.database.incrementCacheData('global_stats', [{location: 'roundHashes', value: false}]);
                switch (blockDataDecoded.poolType) {
                    case global.protos.POOLTYPE.PPLNS:
                        global.database.incrementCacheData('pplns_stats', [{location: 'roundHashes', value: false}]);
                        break;
                    case global.protos.POOLTYPE.PPS:
                        global.database.incrementCacheData('pps_stats', [{location: 'roundHashes', value: false}]);
                        break;
                    case global.protos.POOLTYPE.SOLO:
                        global.database.incrementCacheData('solo_stats', [{location: 'roundHashes', value: false}]);
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
        global.coinFuncs.getBlockHeaderByHash(blockDataDecoded.hash, function(header){
            blockDataDecoded.value = header.reward;
            blockData = global.database.calculateShares(blockDataDecoded, blockId);
            let txn = global.database.env.beginTxn();
            txn.putBinary(global.database.blockDB, blockId, blockData);
            txn.commit();
        });
    };

    this.invalidateBlock = function(blockId){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let blockData = global.protos.Block.decode(txn.getBinary(this.blockDB, blockId));
        blockData.valid = false;
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

    this.setCache = function(cacheKey, cacheData){
        debug("Setting Key: "+cacheKey+ " Data: " + JSON.stringify(cacheData));
        this.refreshEnv();
        let txn = this.env.beginTxn();
        txn.putString(this.cacheDB, cacheKey, JSON.stringify(cacheData));
        txn.commit();
    };

    this.bulkSetCache = function(cacheUpdates){
        let txn = this.env.beginTxn();
        for (let key in cacheUpdates){
            if (cacheUpdates.hasOwnProperty(key)){
                txn.putString(this.cacheDB, key, JSON.stringify(cacheUpdates[key]));
            }
        }
        txn.commit();
    };

    this.cleanShareDB = function() {
        /*
        This function takes the difficulty of the current block, and the last PPS block.  If it's 0, save everything,
        UNLESS global.config.pps.enable is FALSE, then feel free to trash it.
        Due to LMDB under current config, we must delete entire keys, due to this, we save diff * shareMultiLog * 1.5
        global.config.pplns.shareMultiLog should be at least 1.5x your shareMulti, in case of diff spikiing
         */
        let lastPPSBlock = this.getLastBlock();
        if (global.config.pps.enable){
            lastPPSBlock = this.getLastBlock(global.protos.POOLTYPE.PPS);
            if (lastPPSBlock === 0){
                return;
            }
        }
        let lastPPLNSBlock = this.getLastBlock(global.protos.POOLTYPE.PPLNS);
        debug("Last PPS block: "+lastPPSBlock);
        // Hopping into async, we need the current block height to know where to start our indexing...
        async.waterfall([
            function(callback){
                global.coinFuncs.getLastBlockHeader(function(body){
                    callback(null, body.height, Math.floor(body.difficulty * 1.5 * global.config.pplns.shareMultiLog));
                });
            },
            function (lastBlock, difficulty, callback) {
                let shareCount = 0;
                let ppsFound = false;
                let pplnsFound = false;
                let blockList = [];
                debug("Scanning from: "+lastBlock + " for more than: " + difficulty + " shares");
                range.range(0, lastBlock+1).forEach(function (blockID) {
                    blockID = (blockID - lastBlock+1) * -1;
                    if (blockID < 0){
                        return;
                    }
                    debug("Scanning block: " + blockID);
                    let txn = global.database.env.beginTxn({readOnly: true});
                    let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
                    for (let found = (cursor.goToRange(blockID) === blockID); found; found = cursor.goToNextDup()) {
                        if (ppsFound && pplnsFound){
                            cursor.getCurrentBinary(function(key, data) {  // jshint ignore:line
                                if (blockList.indexOf(key) === -1){
                                    blockList.push(key);
                                }
                            });
                        } else {
                            cursor.getCurrentBinary(function(key, data) {  // jshint ignore:line
                                if (key < lastPPSBlock){
                                    ppsFound = true;
                                }
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
                    let blockList = global.database.getBlockList();
                    debug("Got the block list");
                    let totalDeleted = 0;
                    data.forEach(function(block){
                        if ((blockList.indexOf(block) !== -1 && !blockList.unlocked) || block > lastPPLNSBlock){
                            // Don't delete locked blocks.  ffs.
                            // Don't delete blocks that could contain shares.  Even if it's unlikely as all getout.
                            debug("Skipped deleting block: " + block);
                            return;
                        }
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
                console.log("Block cleaning disabled.  Would of removed: " + JSON.stringify(data));
            }
        });
    };


    this.refreshEnv = function(){};

    setInterval(function(){
        global.database.dirtyenv = true;
    }, 900000);  // Set DB env reload for every 15 minutes.
}

module.exports = Database;