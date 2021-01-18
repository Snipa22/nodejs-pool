"use strict";
let range = require('range');
let debug = require('debug')('db');
let async = require('async');
let cleanShareInProgress = false;
let cleanShareStuckCount = 0;

function poolTypeStr(poolType) {
    switch (poolType) {
        case global.protos.POOLTYPE.PPLNS: return 'pplns';
        case global.protos.POOLTYPE.PPS:   return 'pps';
        case global.protos.POOLTYPE.SOLO:  return 'solo';
        default:
            console.error("Unknown poolType: " + poolType.toString());
            return 'pplns';
    }
}

function Database(){
    this.lmdb = require('node-lmdb');
    this.env = null;
    this.shareDB = null;
    this.blockDB = null;
    this.altblockDB = null;
    this.cacheDB = null;

    this.dirtyenv = false;

    this.initEnv = function(){
        global.database.env = new this.lmdb.Env();
        global.database.env.open({
            path: global.config.db_storage_path,
            maxDbs: 10,
            mapSize: 16 * 1024 * 1024 * 1024,
            useWritemap: true,
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
        global.database.altblockDB = this.env.openDbi({
            name: 'altblocks',
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

    this.getBlockList = function(pool_type, first, last) {
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
            for (let found = cursor.goToLast(), i = 0; found; found = cursor.goToPrev()) {
                if (typeof last !== 'undefined' && i >= last) break;
                cursor.getCurrentBinary(function (key, data) {  // jshint ignore:line
                    let blockData = global.protos.Block.decode(data);
                    let poolType = poolTypeStr(blockData.poolType);
                    if (pool_type === false || blockData.poolType === pool_type) {
                        if (typeof first !== 'undefined' && i++ < first) return;
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
            return response; //.sort(global.support.blockCompare);
        } catch (e){
            return response;
        }
    };

    this.getAltBlockList = function(pool_type, coin_port, first, last) {
        debug("Getting altblock list");
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
            let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
            for (let found = cursor.goToLast(), i = 0; found; found = cursor.goToPrev()) {
                if (typeof last !== 'undefined' && i >= last) break;
                cursor.getCurrentBinary(function (key, data) {  // jshint ignore:line
                    let blockData = global.protos.AltBlock.decode(data);
                    let poolType = poolTypeStr(blockData.poolType);
                    if ((pool_type === false || blockData.poolType === pool_type) && (!coin_port || blockData.port === coin_port)) {
                        if (typeof first !== 'undefined' && i++ < first) return;
                        response.push({
                            ts: blockData.timestamp,
                            hash: blockData.hash,
                            diff: blockData.difficulty,
                            shares: blockData.shares,
                            height: blockData.height,
                            valid: blockData.valid,
                            unlocked: blockData.unlocked,
                            pool_type: poolType,
                            value: blockData.value,
                            pay_value: blockData.pay_value,
                            pay_stage: blockData.pay_stage,
                            pay_status: blockData.pay_status,
                            port: blockData.port
                        });
                    }
                });
            }
            cursor.close();
            txn.abort();
            return response; //.sort(global.support.tsCompare);
        } catch (e){
            return response;
        }
    };

    this.storeBulkShares = function(shareObject) {
        let cachedData = {
            global_stats2: { totalHashes: 0, roundHashes: 0 }
        };
        let shares = {};  // Shares keyed by blockID
        let shareCount = 0;
        debug(shareObject.length + ' shares to process');
        shareObject.forEach(function(share){
            //Data is the share object at this point.
            ++ shareCount;
            if (typeof(share.raw_shares) === "number") {
                if (!shares.hasOwnProperty(share.blockHeight)) {
                    shares[share.blockHeight] = [];
                }
                shares[share.blockHeight].push(share);
                let minerID = share.paymentAddress;
                if (typeof(share.paymentID) !== 'undefined' && share.paymentID.length > 10) {
                    minerID = minerID + '.' + share.paymentID;
                }
                let minerIDWithIdentifier = minerID + "_" + share.identifier;
                let port_suffix = typeof(share.port) !== 'undefined' && share.port !== global.config.daemon.port ? "_" + share.port.toString() : "";
                let global_stats1 = "global_stats2";
                let stats_type1 = poolTypeStr(share.poolType) + "_stats2";
                if (!(stats_type1 in cachedData)) {
                    cachedData[stats_type1] = { totalHashes: 0, roundHashes: 0 };
                }
                if (port_suffix === "") {
                    cachedData[global_stats1].totalHashes += share.raw_shares;
                    cachedData[global_stats1].roundHashes += share.raw_shares;
                    cachedData[stats_type1].totalHashes += share.raw_shares;
                    cachedData[stats_type1].roundHashes += share.raw_shares;
                } else {
                    let global_stats2 = global_stats1 + port_suffix;
                    let stats_type2 = stats_type1 + port_suffix;
                    if (!(global_stats2 in cachedData)) cachedData[global_stats2] = { totalHashes: 0, roundHashes: 0 };
                    if (!(stats_type2 in cachedData))   cachedData[stats_type2]   = { totalHashes: 0, roundHashes: 0 };
                    cachedData[global_stats1].totalHashes += share.raw_shares;
                    cachedData[global_stats2].totalHashes += share.raw_shares;
                    cachedData[global_stats2].roundHashes += share.raw_shares;
                    cachedData[stats_type1].totalHashes += share.raw_shares;
                    cachedData[stats_type2].totalHashes += share.raw_shares;
                    cachedData[stats_type2].roundHashes += share.raw_shares;
                }
                if (!cachedData.hasOwnProperty(minerID)) {
                    cachedData[minerID] = {totalHashes: 0, goodShares: 0};
                }
                if (!cachedData.hasOwnProperty(minerIDWithIdentifier)) {
                    cachedData[minerIDWithIdentifier] = {totalHashes: 0, goodShares: 0};
                }
                cachedData[minerIDWithIdentifier].totalHashes += share.raw_shares;
                cachedData[minerID].totalHashes += share.raw_shares;
                const share_num = typeof(share.share_num) !== 'undefined' && share.share_num ? share.share_num : 1;
                cachedData[minerIDWithIdentifier].goodShares += share_num;
                cachedData[minerID].goodShares += share_num;
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
                    if (cachedData.hasOwnProperty(key)){
                        let cacheStore = txn.getString(global.database.cacheDB, key);
                        if (cacheStore === null){
                            txn.putString(global.database.cacheDB, key, JSON.stringify(cachedData[key]));
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
                                    json_cache.roundHashes += cachedData[key].roundHashes;
                                } else {
                                    json_cache.roundHashes = cachedData[key].roundHashes;
                                }
                            }
                            txn.putString(global.database.cacheDB, key, JSON.stringify(json_cache));
                        }
                    }
                }
                let blocksSeen = 0;
                for (let key in shares){
                    if (shares.hasOwnProperty(key)){
                        ++ blocksSeen;
                        let sharesSeen = 0;
                        shares[key].forEach(function(final_share){  // jshint ignore:line
                            ++ sharesSeen;
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
            console.error("Ran into an error storing an invalid share.  Damn!");
            callback(false);
        }
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

    // hash -> time
    let orphanBlocks = {};

    this.storeBlock = function(blockId, blockData, callback){
        this.refreshEnv();
        try{
            let blockDataDecoded = global.protos.Block.decode(blockData);
            global.coinFuncs.getBlockHeaderByHash(blockDataDecoded.hash, function(err, header){
                // after 5 minutes of submit attempts finally cosider this block as orphan
                if (err && header) {
                    const is_orphan1 = header.orphan_status && header.orphan_status === true;
                    const is_orphan2 = header.error && typeof(header.error.message) === 'string' && (
                           header.error.message.indexOf("can't get block by hash") > -1 ||
                           header.error.message.indexOf("hash wasn't found") > -1 ||
                           header.error.message.indexOf("Transaction not found") > -1
                    );
                    if (is_orphan1 || is_orphan2) {
                        let time_now = Date.now();
                        if (blockDataDecoded.hash in orphanBlocks) {
                            if (time_now - orphanBlocks[blockDataDecoded.hash] > 10*60*1000) {
                                console.log("Stopped attempts to get block reward for " + blockDataDecoded.hash);
                                err = false;
                                header = {};
                                header.reward = 0;
                                blockDataDecoded.valid = false;
                                blockDataDecoded.unlocked = true;
                            }
                         } else {
                            console.log("Started attempts to store possibly orphan block " + blockDataDecoded.hash);
                            orphanBlocks[blockDataDecoded.hash] = time_now;
                        }
                    }
                }
                if (err || typeof(header) === 'undefined' || !header){
                    setTimeout(function () { return callback(false) }, 30*1000);
                    return;
                }
                blockDataDecoded.value = header.reward;
                //blockData = global.database.calculateShares(blockDataDecoded, blockId);
                let shares = global.database.getCache(poolTypeStr(blockDataDecoded.poolType) + "_stats2");
                blockDataDecoded.shares = shares ? shares.roundHashes : 0;
                blockData = global.protos.Block.encode(blockDataDecoded);
                let txn = global.database.env.beginTxn();
                // this is very rare case if block with smae height is found by several leafs (one that is stored later should be orphan with 0 reward)
                if (txn.getBinary(global.database.blockDB, blockId) !== null) {
                    txn.abort();
                    console.error("Can't store already stored block with " + blockId.toString() + " key and " + header.reward.toString() + " value: " + JSON.stringify(blockDataDecoded));
                    return callback(true);
                }
                txn.putBinary(global.database.blockDB, blockId, blockData);
                txn.commit();
                global.database.incrementCacheData('global_stats2', [{location: 'roundHashes', value: false}]);
                global.database.incrementCacheData(poolTypeStr(blockDataDecoded.poolType) + '_stats2', [{location: 'roundHashes', value: false}]);
                return callback(true);
            });
        } catch (e) {
            console.error("ERROR IN STORING BLOCK.  LOOK INTO ME PLZ: " + JSON.stringify(e));
            throw new Error("Error in block storage");
        }
    };

    let potentiallyBadBlocks = {}; // port -> block hash that has issues that will move into badBlocks after we will find good block for same port
    let badBlocks = {}; // block hashes that we just start ignore (can't find incoming wallet tx)
    let busyPorts = {}; // ports that are alredy have active getPortBlockHeaderByHash request

    this.storeAltBlock = function(blockId, blockData, callback){
        this.refreshEnv();
        try{
            let blockDataDecoded = global.protos.AltBlock.decode(blockData);
            if (blockDataDecoded.port in busyPorts) {
                console.error("Pausing altblock with " + blockDataDecoded.port.toString() + " port and " + blockDataDecoded.height.toString() + " height processing");
                setTimeout(function () { return callback(false) }, 30*1000);
                return;
            }
            busyPorts[blockDataDecoded.port] = 1;
            global.coinFuncs.getPortBlockHeaderByHash(blockDataDecoded.port, blockDataDecoded.hash, function(err, header){
                delete busyPorts[blockDataDecoded.port];
                // after 5 minutes of submit attempts finally cosider this block as orphan
                let is_orphan = false;
                if (err && header) {
                    const is_orphan1 = header.orphan_status && header.orphan_status === true;
                    const is_orphan2 = header.error && typeof(header.error.message) === 'string' && (
                        header.error.message.indexOf("can't get block by hash") > -1 ||
                        header.error.message.indexOf("Requested hash wasn't found in main blockchain") > -1
                    );
                    const is_orphan3 = header.topoheight && header.topoheight === -1;
                    if (is_orphan1 || is_orphan2 || is_orphan3) {
                        let time_now = Date.now();
                        if (blockDataDecoded.hash in orphanBlocks) {
                            if (time_now - orphanBlocks[blockDataDecoded.hash] > 10*60*1000) {
                                is_orphan = true;
                                console.log("Stopped attempts to get block reward for " + blockDataDecoded.hash);
                                err = false;
                                header = {};
                                header.reward = 0;
                                blockDataDecoded.valid = false;
                                blockDataDecoded.unlocked = true;
                            }
                        } else {
                            console.log("Started attempts to store possibly orphan block " + blockDataDecoded.hash);
                            orphanBlocks[blockDataDecoded.hash] = time_now;
                            setTimeout(function () { return callback(false) }, 30*1000);
                            return;
                        }
                    }
                }
                if (err || typeof(header) === 'undefined' || !header) { // bad block and not orphan
                    if (blockDataDecoded.hash in badBlocks) {
                      console.error("Invalidating " + blockDataDecoded.port + " port block hash " + blockDataDecoded.hash);
                      return callback(true);
                    }
                    if (!(blockDataDecoded.port in potentiallyBadBlocks)) potentiallyBadBlocks[blockDataDecoded.port] = {};
                    potentiallyBadBlocks[blockDataDecoded.port][blockDataDecoded.hash] = 1;
                    setTimeout(function () { return callback(false) }, 30*1000);
                    return;
                }
                if (!is_orphan) { // now we found good block (not orphan) and we can move potentiallyBadBlocks to badBlocks
                   if (blockDataDecoded.port in potentiallyBadBlocks) {
                       for (let hash in potentiallyBadBlocks[blockDataDecoded.port]) {
                          console.log("Allowing bad " + blockDataDecoded.port + " port block hash " + hash);
                          badBlocks[hash] = 1;
                       }
                       delete potentiallyBadBlocks[blockDataDecoded.port];
                   }
                }
                blockDataDecoded.value = header.reward;
                blockDataDecoded.pay_value = 0;
                //blockData = global.database.calculateShares(blockDataDecoded, blockId);
                let port_suffix = "_" + blockDataDecoded.port.toString();
                let shares = global.database.getCache(poolTypeStr(blockDataDecoded.poolType) + "_stats2" + port_suffix);
                blockDataDecoded.shares = shares ? shares.roundHashes : 0;
                blockData = global.protos.AltBlock.encode(blockDataDecoded);
                if (global.database.isAltBlockInDB(blockDataDecoded.port, blockDataDecoded.height)) {
                    console.error("Can't store already stored altblock with " + blockDataDecoded.port.toString() + " port and " + blockDataDecoded.height.toString() + " height and " + header.reward.toString() + " value: " + JSON.stringify(blockDataDecoded));
                    return callback(true);
                }
                let txn = global.database.env.beginTxn();
                while (txn.getBinary(global.database.altblockDB, blockId) !== null) {
                  console.error("Can't store altblock with " + blockId.toString() + " key, trying to increment it");
                  ++ blockId;
                }
                txn.putBinary(global.database.altblockDB, blockId, blockData);
                txn.commit();
                global.database.incrementCacheData('global_stats2' + port_suffix, [{location: 'roundHashes', value: false}]);
                global.database.incrementCacheData(poolTypeStr(blockDataDecoded.poolType) + '_stats2' + port_suffix, [{location: 'roundHashes', value: false}]);
                return callback(true);
            });
        } catch (e) {
            console.error("ERROR IN STORING BLOCK.  LOOK INTO ME PLZ: " + JSON.stringify(e));
            throw new Error("Error in block storage");
        }
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

    this.invalidateAltBlock = function(blockId){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let blockData = global.protos.AltBlock.decode(txn.getBinary(this.altblockDB, blockId));
        blockData.valid = false;
        blockData.unlocked = true;
        txn.putBinary(this.altblockDB, blockId, global.protos.AltBlock.encode(blockData));
        txn.commit();
    };

    this.changeAltBlockPayStageStatus = function(blockId, pay_stage, pay_status){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let blockData = global.protos.AltBlock.decode(txn.getBinary(this.altblockDB, blockId));
        blockData.pay_stage  = pay_stage;
        blockData.pay_status = pay_status;
        txn.putBinary(this.altblockDB, blockId, global.protos.AltBlock.encode(blockData));
        txn.commit();
    };

    this.moveAltBlockReward = function(srcBlockId, dstBlockId, srcAmount){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let srcBlockData = global.protos.AltBlock.decode(txn.getBinary(this.altblockDB, srcBlockId));
        let dstBlockData = global.protos.AltBlock.decode(txn.getBinary(this.altblockDB, dstBlockId));
        dstBlockData.value += srcAmount;
        srcBlockData.value = 0;
        srcBlockData.pay_stage  = "Payed by other block";
        srcBlockData.pay_status = "Will be payed by block " + dstBlockData.hash + " on " + dstBlockData.height + " height";
        srcBlockData.unlocked   = true;
        txn.putBinary(this.altblockDB, srcBlockId, global.protos.AltBlock.encode(srcBlockData));
        txn.putBinary(this.altblockDB, dstBlockId, global.protos.AltBlock.encode(dstBlockData));
        txn.commit();
    };

    this.changeAltBlockPayValue = function(blockId, pay_value){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let blockData = global.protos.AltBlock.decode(txn.getBinary(this.altblockDB, blockId));
        blockData.pay_value  = pay_value;
        txn.putBinary(this.altblockDB, blockId, global.protos.AltBlock.encode(blockData));
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

    this.getValidLockedAltBlocks = function(){
        this.refreshEnv();
        let txn = this.env.beginTxn({readOnly: true});
        let cursor = new this.lmdb.Cursor(txn, this.altblockDB);
        let blockList = [];
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.AltBlock.decode(data);
                if (blockData.valid === true && blockData.unlocked === false){
                    blockData.id = key;
                    blockList.push(blockData);
                }
            });
        }
        cursor.close();
        txn.commit();
        return blockList;
    };

    this.isAltBlockInDB = function(port, height){
        this.refreshEnv();
        let txn = this.env.beginTxn({readOnly: true});
        let cursor = new this.lmdb.Cursor(txn, this.altblockDB);
        let isBlockFound = false;
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.AltBlock.decode(data);
                if (blockData.port === port && blockData.height === height){
                    isBlockFound = true;
                }
            });
        }
        cursor.close();
        txn.commit();
        return isBlockFound;
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

    this.unlockAltBlock = function(blockHex){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let cursor = new this.lmdb.Cursor(txn, this.altblockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            let altblockDB = this.altblockDB;
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.AltBlock.decode(data);
                if (blockData.hash === blockHex){
                    blockData.unlocked = true;
                    txn.putBinary(altblockDB, key, global.protos.AltBlock.encode(blockData));
                }
            });
            altblockDB = null;
        }
        cursor.close();
        txn.commit();
    };

    this.payReadyBlock = function(blockHex){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let cursor = new this.lmdb.Cursor(txn, this.blockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            let blockDB = this.blockDB;
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.Block.decode(data);
                if (blockData.hash === blockHex){
                    blockData.pay_ready = true;
                    txn.putBinary(blockDB, key, global.protos.Block.encode(blockData));
                }
            });
            blockDB = null;
        }
        cursor.close();
        txn.commit();
    };

    this.payReadyAltBlock = function(blockHex){
        this.refreshEnv();
        let txn = this.env.beginTxn();
        let cursor = new this.lmdb.Cursor(txn, this.altblockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            let altblockDB = this.altblockDB;
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.AltBlock.decode(data);
                if (blockData.hash === blockHex){
                    blockData.pay_ready = true;
                    txn.putBinary(altblockDB, key, global.protos.AltBlock.encode(blockData));
                }
            });
            altblockDB = null;
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

    this.bulkSetCache = function(cacheUpdates){
        let txn = this.env.beginTxn();
        txn.putString(this.cacheDB, 'cacheUpdate', 'cacheUpdate');
        txn.commit();
        //let size = 0;
        txn = this.env.beginTxn();
        for (const [key, value] of Object.entries(cacheUpdates)) {
          const value_str = JSON.stringify(value);
          txn.putString(this.cacheDB, key, value_str);
          //size += key.length + value_str.length;
        }
        txn.del(this.cacheDB, 'cacheUpdate');
        txn.commit();
        //this.env.sync(function() {
          //console.log("Wrote " + size + " bytes to LMDB");
        //});
    };

    this.getOldestLockedBlockHeight = function(){
        /*
        6-29-2017 - Snipa -
        This function returns a decompressed block proto for the first locked block in the system as part of the
        share depth functions.  DO NOT BLINDLY REPLACE getLastBlock WITH THIS FUNCTION.
        */
        this.refreshEnv();
        debug("Getting the oldest locked block in the system");

        let oldestLockedBlockHeight = null;

        let txn = this.env.beginTxn({readOnly: true});

        {   let cursor = new this.lmdb.Cursor(txn, this.altblockDB);
            for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                 cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                     let blockData = global.protos.AltBlock.decode(data);
                     if (blockData.unlocked === false && blockData.pay_ready !== true){
                         if (oldestLockedBlockHeight === null || oldestLockedBlockHeight > blockData.anchor_height) {
                             oldestLockedBlockHeight = blockData.anchor_height;
                         }
                     }
                 });
            }
            cursor.close();
        }

        {   let cursor = new this.lmdb.Cursor(txn, this.blockDB);
            for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                 cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                     if (oldestLockedBlockHeight !== null && oldestLockedBlockHeight <= key) return;
                     let blockData = global.protos.Block.decode(data);
                     if (blockData.unlocked === false && blockData.pay_ready !== true) {
                         oldestLockedBlockHeight = key;
                     }
                 });
            }
            cursor.close();
        }

        txn.commit();

        if (oldestLockedBlockHeight !== null) {
            console.log("Got the oldest locked block in the system at height: " + oldestLockedBlockHeight.toString());
        } else {
            console.log("There are no locked blocks in the system. Woohoo!");
        }
        return oldestLockedBlockHeight;
    };

    this.cleanShareDB = function() {
        /*
         This function takes the difficulty of the current block, and the last PPS block.  If it's 0, save everything,
         UNLESS global.config.pps.enable is FALSE, then feel free to trash it.
         Due to LMDB under current config, we must delete entire keys, due to this, we save diff * shareMulti * 2
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
	if (cleanShareInProgress) {
	    console.error("CleanShareDB already running");
	    ++cleanShareStuckCount;
	    if (cleanShareStuckCount > 5) global.support.sendEmail(global.config.general.adminEmail,"LongRunner stuck",cleanShareStuckCount);
	    return; // already running
	}
	cleanShareInProgress = true;
        let oldestLockedBlockHeight = this.getOldestLockedBlockHeight();
        async.waterfall([
            function(callback){
                if (oldestLockedBlockHeight === null) {
                    callback(null, null, null);
                } else {
                    global.coinFuncs.getBlockHeaderByID(oldestLockedBlockHeight, (err, result) => {
                        if (err !== null) {
                            console.error("Can't get block with " + oldestLockedBlockHeight + " height: ", err);
                            return callback(true);
                        }
                        callback(null, oldestLockedBlockHeight, result.difficulty);
                    });
                }
            },
            function(oldestLockedBlockHeight, oldestLockedBlockDifficulty, callback){
                global.coinFuncs.getLastBlockHeader(function(err, body){
                    if (err !== null) {
                        console.error("Last block header request failed!");
                        return callback(true);
                    }
                    if (oldestLockedBlockHeight === null){
                        /*
                        If there's no locked blocks, then allow the system to scan from the PPS depth downwards if PPS
                        is enabled.
                        Save enough shares so that the diff * share multi * 30% for buffer.
                         */
                        if (global.config.pps.enable){
                            // If PPS is enabled, we scan for new blocks at cur height - blocksRequired/2.
                            // We need to save shares back that far at the least.
                            callback(null, body.height - Math.floor(global.config.payout.blocksRequired/2), Math.floor(body.difficulty * global.config.pplns.shareMulti * 2));
                        } else {
                            // Otherwise, we can just start from the current height.  Woo!
                            callback(null, body.height, Math.floor(body.difficulty * global.config.pplns.shareMulti * 2));
                        }

                    } else {
                        if (body.height - oldestLockedBlockHeight > global.config.general.blockCleanWarning) {
                            global.support.sendEmail(global.config.general.adminEmail, "longRunner module can not clean DB good enough", "longRunner can not clean " + (body.height - oldestLockedBlockHeight) + " block from DB!");
                        }
                        /*
                        Otherwise, start the scan from the oldest locked block downwards.
                        This protects against the blockManager being messed up and not unlocking blocks.
                        This will ensure that enough shares are in place to unlock all blocks.
                        If the block is Solo, PPLNS or PPS, it doesn't matter.
                         */
                        if (global.config.pps.enable && oldestLockedBlockHeight > body.height - Math.floor(global.config.payout.blocksRequired/2)) {
                            // If PPS is enabled, and the oldestLockedBlockHeight > the PPS minimum, start from the PPS minimum.
                            callback(null, body.height - Math.floor(global.config.payout.blocksRequired/2), Math.floor(body.difficulty * global.config.pplns.shareMulti * 2));
                        } else {
                            // If PPS isn't enabled, or the oldestLockedBlockHeight < the PPS minimum, then start from there.
                            callback(null, oldestLockedBlockHeight, Math.floor(oldestLockedBlockDifficulty * global.config.pplns.shareMulti * 2));
                        }
                    }
                });
            },
            function (lastBlock, difficulty, callback) {
                let shareCount = 0;
                let pplnsFound = false;
                let blockSet = {};
                console.log("Scanning from: "+lastBlock + " for more than: " + difficulty + " shares");
                let txn = global.database.env.beginTxn({readOnly: true});
                let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
                range.range(lastBlock-1, 0, -1).forEach(function (blockID) {
                    debug("Scanning block: " + blockID);
                    for (let found = (cursor.goToRange(parseInt(blockID)) === blockID); found; found = cursor.goToNextDup()) {
                        if (pplnsFound) {
                            blockSet[blockID] = 1;
                            break;
                        } else {
                            cursor.getCurrentBinary(function(key, data) {  // jshint ignore:line
                                try{
                                    let shareData = global.protos.Share.decode(data);
                                    if (shareData.poolType === global.protos.POOLTYPE.PPLNS){
                                        shareCount += shareData.shares2;
                                    }
                                } catch(e){
                                    console.error("Invalid share");
                                }
                            });
                            if (shareCount >= difficulty){
                                pplnsFound = true;
                                console.log("Found the first block to be deleted at " + blockID + " height");
                                break;
                            }
                        }
                    }
                });
                cursor.close();
                txn.abort();
                console.log("Scan finished");
                callback(null, Array.from(Object.keys(blockSet)));
            }
        ], function(err, data){
            if (err !== null) {
                console.error("ERROR with cleaning up because of daemon stuck: ");
                cleanShareInProgress = false;
                return;
            }
            if (global.config.general.blockCleaner === true){
                if(data.length > 0){
                    global.database.refreshEnv();
                    let totalDeleted = 0;
                    let totalDeleted2 = 0;
                    console.log("Block cleaning started: removing " + data.length + " block share records");
                    let txn = global.database.env.beginTxn();
                    data.forEach(function(block){
                        ++ totalDeleted;
                        ++ totalDeleted2;
                        debug("Deleted block: " + parseInt(block));
                        txn.del(global.database.shareDB, parseInt(block));
			if (totalDeleted2 > 100) {
			    txn.commit();
			    txn = global.database.env.beginTxn();
                            totalDeleted2 = 0;
			}
                    });
                    txn.commit();
                    console.log("Block cleaning finished: removed " + totalDeleted + " block share records");
                }
                global.database.env.sync(function(){
                });
            } else {
                console.log("Block cleaning disabled.  Would have removed: " + JSON.stringify(data));
            }
            cleanShareInProgress = false;
            cleanShareStuckCount = 0;
            console.log("Done cleaning up the share DB");
        });
    };

    this.refreshEnv = function(){};

    setInterval(function(){
        global.database.dirtyenv = true;
    }, 900000);  // Set DB env reload for every 15 minutes.
}

module.exports = Database;
