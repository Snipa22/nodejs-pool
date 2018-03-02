"use strict";
let range = require('range');
let mysql = require("promise-mysql");
let fs = require("fs");
let argv = require('minimist')(process.argv.slice(2));
let config = fs.readFileSync("../config.json");
let coinConfig = fs.readFileSync("../coinConfig.json");
let protobuf = require('protocol-buffers');

global.support = require("../lib/support.js")();
global.config = JSON.parse(config);
global.mysql = mysql.createPool(global.config.mysql);
global.protos = protobuf(fs.readFileSync('../lib/data.proto'));
let comms;
comms = require('../lib/local_comms');
global.database = new comms();
global.database.initEnv();

        let txn = global.database.env.beginTxn({readOnly: true});

        {   let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
            let lastBlock = 1520747;
            range.range(lastBlock-1, 1520747-100, -1).forEach(function (blockID) {
              for (let found = (cursor.goToRange(parseInt(blockID)) === blockID); found; found = cursor.goToNextDup()) {
                 cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                     let shareData = global.protos.Share.decode(data);
                     if (shareData.paymentAddress === "") {
                       var d = new Date(shareData.timestamp);
                       console.log(d.toString() + ": " + JSON.stringify(shareData))
                     }
                 });
              }
            });
            cursor.close();
        }

        txn.commit();

process.exit();

// 05:43
// 07:51