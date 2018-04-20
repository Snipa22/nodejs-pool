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

global.coinFuncs.getPortBlockHeaderByHash(argv.blockPort, argv.blockHash, (err, body) => {
    if (err !== null) {
        console.log("Block "+argv.blockHash+" still has invalid hash for " + argv.blockPort + "!  Exiting!");
        process.exit();
    }
    global.database.validateAltBlock(argv.blockPort, argv.blockHash);
    console.log("Block "+argv.blockHash+" was validated!  Exiting!");
    process.exit();
});


