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
global.database.unlockBlock(argv.blockHash);
console.log("Block "+argv.blockHash+" un-locked!  Exiting!");
process.exit();
