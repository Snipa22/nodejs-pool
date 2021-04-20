"use strict";
const mysql = require("promise-mysql");
const fs = require("fs");
const argv = require('minimist')(process.argv.slice(2));
const protobuf = require('protocol-buffers');
const path = require('path');
const {loadConfig} = require('./lib/common');

const coinConfig = fs.readFileSync("./coinConfig.json");

const jsonConfig = require('./config.json');
global.mysql = mysql.createPool(jsonConfig.mysql);
global.support = require("./lib/support.js")();
global.config = {};
global.protos = protobuf(fs.readFileSync('./lib/data.proto'));
global.argv = argv;

let comms;
let coinInc;

// Config Table Layout
// <module>.<item>

loadConfig()
    .then(dbConfig => {
        Object.assign(global.config, dbConfig, jsonConfig);
    })
    .then(function () {
        console.log(`Selected coin: ${global.config.coin}`);
        global.config['coin'] = JSON.parse(coinConfig)[global.config.coin];
        coinInc = require(global.config.coin.funcFile);
        global.coinFuncs = new coinInc();
        if (argv.module === 'pool') {
            comms = require('./lib/remote_comms');
        } else {
            comms = require('./lib/local_comms');
        }
        global.database = new comms();
        global.database.initEnv();
        global.coinFuncs.blockedAddresses.push(global.config.pool.address);
        global.coinFuncs.blockedAddresses.push(global.config.payout.feeAddress);
        if (argv.hasOwnProperty('tool') && fs.existsSync('./manage_scripts/' + argv.tool + '.js')) {
            require('./manage_scripts/' + argv.tool + '.js');
        } else if (argv.hasOwnProperty('module')) {
            switch (argv.module) {
                case 'pool':
                    loadPorts().then(ports => {
                        global.config.ports = ports;
                        require('./lib/pool');
                    });
                    break;
                case 'blockManager':
                    require('./lib/blockManager.js');
                    break;
                case 'altblockManager':
                    require('./lib2/altblockManager.js');
                    break;
                case 'altblockExchange':
                    require('./lib2/altblockExchange.js');
                    break;
                case 'payments':
                    require('./lib/payments.js');
                    break;
                case 'api':
                    require('./lib/api.js');
                    break;
                case 'remoteShare':
                    require('./lib/remoteShare.js');
                    break;
                case 'worker':
                    require('./lib/worker.js');
                    break;
                case 'pool_stats':
                    require('./lib/pool_stats.js');
                    break;
                case 'longRunner':
                    require('./lib/longRunner.js');
                    break;
                default:
                    console.error("Invalid module provided.  Please provide a valid module");
                    process.exit(1);
            }
        } else {
            console.error("Invalid module/tool provided.  Please provide a valid module/tool");
            console.error("Valid Modules: pool, blockManager, payments, api, remoteShare, worker, longRunner");
            let valid_tools = "Valid Tools: ";
            fs.readdirSync('./manage_scripts/').forEach(function (line) {
                valid_tools += path.parse(line).name + ", ";
            });
            valid_tools = valid_tools.slice(0, -2);
            console.error(valid_tools);
            process.exit(1);
        }
    });


function loadPorts() {
    return global.mysql.query("SELECT * FROM port_config").then(rows =>
        rows.map(row => {
            row.hidden = row.hidden === 1;
            row.ssl = row.ssl === 1;
            return {
                port: row.poolPort,
                difficulty: row.difficulty,
                desc: row.portDesc,
                portType: row.portType,
                hidden: row.hidden,
                ssl: row.ssl
            };
        })
    );
}