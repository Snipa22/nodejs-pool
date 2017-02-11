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
            noSync: true,
            mapAsync: true,
            useWritemap: true,
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
                cached[intDict.location] += intDict.value;
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
            this.incrementCacheData('global_stats', [{location: 'totalHashes', value: share.shares}]);
            switch (share.poolType) {
                case global.protos.POOLTYPE.PPLNS:
                    this.incrementCacheData('pplns_stats', [{location: 'totalHashes', value: share.shares}]);
                    break;
                case global.protos.POOLTYPE.PPS:
                    this.incrementCacheData('pps_stats', [{location: 'totalHashes', value: share.shares}]);
                    break;
                case global.protos.POOLTYPE.SOLO:
                    this.incrementCacheData('solo_stats', [{location: 'totalHashes', value: share.shares}]);
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


    this.refreshEnv = function(){
        if (this.dirtyenv === true){
            console.log("Database Worker: Reloading LMDB Env");
            global.database.env.sync(function(){
            });
            clearInterval(this.intervalID);
            global.database.env.close();
            this.initEnv();
        }
    };

    setInterval(function(){
        global.database.dirtyenv = true;
    }, 900000);  // Set DB env reload for every 15 minutes.
}

module.exports = Database;