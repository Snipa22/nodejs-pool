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
    comms = require('../lib/local_comms');
    global.database = new comms();
    global.database.initEnv();
    global.coinFuncs.blockedAddresses.push(global.config.pool.address);
    global.coinFuncs.blockedAddresses.push(global.config.payout.feeAddress);
}).then(function(){
 	let time_now = Date.now();
        /*global.database.storeAltBlock(Math.floor(time_now / 1000), global.protos.AltBlock.encode({
            hash: "517c5c49137d2a7b7c5c58297bea10940bbd5ba23d77d589069b16cadec95a03",
            difficulty: 2149619256,
            shares: 0,
            timestamp: time_now,
            poolType: global.protos.POOLTYPE.PPLNS,
            unlocked: false,
            valid: true,
            port: 26968,
            height: 157909,
            anchor_height: 1509989
        }));*/

});
