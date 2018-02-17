"use strict";
let mysql = require("promise-mysql");
let fs = require("fs");
let argv = require('minimist')(process.argv.slice(2));
let config = fs.readFileSync("../config.json");
let coinConfig = fs.readFileSync("../coinConfig.json");
let protobuf = require('protocol-buffers');
const request = require('request');

global.support = require("../lib/support.js")();
global.config = JSON.parse(config);
global.mysql = mysql.createPool(global.config.mysql);
global.protos = protobuf(fs.readFileSync('../lib/data.proto'));
let comms;
let coinInc;


// Config Table Layout
// <module>.<item>

global.mysql.query("SELECT * FROM config").then(function (rows) {
    rows.forEach(function (row){
        if (!global.config.hasOwnProperty(row.module)){
            global.config[row.module] = {};
        }
        if (global.config[row.module].hasOwnProperty(row.item)){
            return;
        }
        switch(row.item_type){
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
}).then(function(){
    global.config['coin'] = JSON.parse(coinConfig)[global.config.coin];
    coinInc = require("." + global.config.coin.funcFile);
    global.coinFuncs = new coinInc();
    if (argv.module === 'pool'){
        comms = require('../lib/remote_comms');
    } else {
        comms = require('../lib/local_comms');
    }
    global.database = new comms();
    global.database.initEnv();
    global.coinFuncs.blockedAddresses.push(global.config.pool.address);
    global.coinFuncs.blockedAddresses.push(global.config.payout.feeAddress);
}).then(function(){
    /*
     message Block {
     required string hash = 1;
     required int64 difficulty = 2;
     required int64 shares = 3;
     required int64 timestamp = 4;
     required POOLTYPE poolType = 5;
     required bool unlocked = 6;
     required bool valid = 7;
     optional int64 value = 8;
     }
     */
   global.mysql.query("SELECT * FROM blocks").then(function(rows){
       rows.forEach(function(row){
           let block = {
               hash: row.hex,
               difficulty: row.difficulty,
               shares: row.shares,
               timestamp: global.support.formatDateFromSQL(row.find_time)*1000,
               poolType: null,
               unlocked: row.unlocked === 1,
               valid: row.valid === 1
           };
           switch(row.pool_type){
               case 'pplns':
                   block.poolType = global.protos.POOLTYPE.PPLNS;
                   break;
               case 'solo':
                   block.poolType = global.protos.POOLTYPE.SOLO;
                   break;
               case 'prop':
                   block.poolType = global.protos.POOLTYPE.PROP;
                   break;
               case 'pps':
                   block.poolType = global.protos.POOLTYPE.PPS;
                   break;
               default:
                   block.poolType = global.protos.POOLTYPE.PPLNS;
           }
           global.coinFuncs.getBlockHeaderByHash(block.hash, function(err, header) {
                if (!err) {
                    block.value = header.reward;
                    let txn = global.database.env.beginTxn();
                    txn.putBinary(global.database.blockDB, row.height, global.protos.Block.encode(block));
                    txn.commit();
                }
           });
       });
   });
});