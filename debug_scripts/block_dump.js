"use strict";
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

        {   let cursor = new global.database.lmdb.Cursor(txn, global.database.blockDB);
            for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                 cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                     let blockData = global.protos.Block.decode(data);
                     console.log(key + ": " + JSON.stringify(blockData))
                 });
            }
            cursor.close();
        }

        txn.commit();

process.exit();