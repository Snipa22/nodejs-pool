"use strict";
let mysql = require("promise-mysql");
let fs = require("fs");
const async = require("async");
let config = fs.readFileSync("../config.json");
let coinConfig = fs.readFileSync("../coinConfig.json");
let protobuf = require('protocol-buffers');

global.support = require("../lib/support.js")();
global.config = JSON.parse(config);
global.config['coin'] = JSON.parse(coinConfig)[global.config.coin];
let coinInc = require("../" + global.config.coin.funcFile);
global.coinFuncs = new coinInc();
global.mysql = mysql.createPool(global.config.mysql);
global.protos = protobuf(fs.readFileSync('../lib/data.proto'));
let comms;
comms = require('../lib/local_comms');
global.database = new comms();
global.database.initEnv();
console.log('Determining the blocks that have shares and how many shares are in them.');
global.mysql.query("SELECT * FROM config").then(function (rows) {
    rows.forEach(function (row) {
        if (!global.config.hasOwnProperty(row.module)) {
            global.config[row.module] = {};
        }
        if (global.config[row.module].hasOwnProperty(row.item)) {
            return;
        }
        switch (row.item_type) {
            case 'int':
                global.config[row.module][row.item] = parseInt(row.item_value);
                break;
            case 'bool':
                global.config[row.module][row.item] = (row.item_value === "true");
                break;
            case 'string':
                global.config[row.module][row.item] = row.item_value;
                break;
            case 'float':
                global.config[row.module][row.item] = parseFloat(row.item_value);
                break;
        }
    });
}).then(function () {
    global.coinFuncs.getLastBlockHeader(function (body) {
        let null_blocks = 0;
        let blockCheckHeight = body.result.block_header.height;
        async.doWhilst(function (callback) {
            let txn = global.database.env.beginTxn({readOnly: true});
            let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
            let intData = {shares: 0, pplns: 0, pps: 0, solo: 0};
            for (let found = (cursor.goToRange(blockCheckHeight) === blockCheckHeight); found; found = cursor.goToNextDup()) {
                cursor.getCurrentBinary(function (key, data) {  // jshint ignore:line
                    let shareData;
                    try {
                        shareData = global.protos.Share.decode(data);
                    } catch (e) {
                        console.error(e);
                        return;
                    }
                    intData.shares += 1;
                    switch (shareData.poolType) {
                        case global.protos.POOLTYPE.PPLNS:
                            intData.pplns += shareData.shares;
                            break;
                        case global.protos.POOLTYPE.SOLO:
                            intData.solo += shareData.shares;
                            break;
                        case global.protos.POOLTYPE.PPS:
                            intData.pps += shareData.shares;
                            break;
                    }
                });
            }
            cursor.close();
            txn.abort();
            setImmediate(callback, null, intData);
        }, function (shareCounts) {
            if (shareCounts.shares === 0) {
                null_blocks += 1;
                if (null_blocks >= 30) {
                    return false;
                }
            }
            console.log('Block: ' + blockCheckHeight + ' has: ' + shareCounts.shares + ' shares with PPLNS/PPS/SOLO Hashes of: ' + shareCounts.pplns + '/' + shareCounts.pps + '/' + shareCounts.solo + '/');
            blockCheckHeight = blockCheckHeight - 1;
            return true;
        }, function (err) {
            console.log('Aborting scan depth due to 30 blocks with no shares.  Oh Teh Noez.');
            process.exit();
        });
    });
});