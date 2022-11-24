"use strict";
const bignum = require('bignum');
const cnUtil = require('cryptoforknote-util');
const multiHashing = require('cryptonight-hashing');
const crypto = require('crypto');
const debug = require('debug')('coinFuncs');
const process = require('process');
const fs = require('fs');
const net = require('net');
const async = require('async');
const child_process = require('child_process');

const reXMRig     = /XMRig(?:-[a-zA-Z]+)?\/(\d+)\.(\d+)\./; // 2.8.0
const reXMRSTAKRX = /\w+-stak-rx\/(\d+)\.(\d+)\.(\d+)/; // 1.0.1
const reXMRSTAK   = /\w+-stak(?:-[a-zA-Z]+)?\/(\d+)\.(\d+)\.(\d+)/; // 2.5.0
const reXNP       = /xmr-node-proxy\/(\d+)\.(\d+)\.(\d+)/; // 0.3.2
const reCAST      = /cast_xmr\/(\d+)\.(\d+)\.(\d+)/; // 1.5.0
const reSRB       = /SRBMiner Cryptonight AMD GPU miner\/(\d+)\.(\d+)\.(\d+)/; // 1.6.8
const reSRBMULTI  = /SRBMiner-MULTI\/(\d+)\.(\d+)\.(\d+)/; // 0.1.5

const pool_nonce_size = 16+1; // 1 extra byte for old XMR and new TRTL daemon bugs
const port2coin = {
//    "11181": "AEON",
    "11898": "TRTL",
    "12211": "RYO",
    "17750": "XHV",
    "18081": "",
    "18981": "GRFT",
    "11812": "XLA",
    "25182": "TUBE",
//    "34568": "WOW",
    "38081": "MSR",
    "48782": "LTHN",
    "19734": "SUMO",
    "13007": "IRD",
//    "13102": "XTA",
    "19994": "ARQ",
    "33124": "XTNC",
    "19281": "XMV",
    "19950": "XWP",
    "9231" : "XEQ",
//    "20206": "DERO",
//    "18181": "XMC",
    "16000": "CCX",
    "8766" : "RVN",
//    "8545" : "ETH",
    "8645" : "ETC",
    "2086" : "BLOC",
    "9053" : "ERG",
    "9998" : "RTM",
};
const port2blob_num = {
//    "11181": 7,   // AEON
    "11898": 2,   // TRTL
    "12211": 4,   // RYO
    "17750": 11,  // XHV
    "18081": 0,   // XMR
    "18981": 0,   // GRFT
    "11812": 0,   // XLA
    "25182": 10,  // TUBE
//    "34568": 0,   // WOW
    "38081": 6,   // MSR
    "48782": 0,   // LTHN
    "19734": 0,   // SUMO
    "13007": 2,   // IRD
//    "13102": 12,  // XTA
    "19994": 0,   // ARQ
    "19281": 8,   // XMV
    "33124": 9,   // XTNC
    "19950": 8,   // XWP
    "9231" : 5,   // XEQ
//    "18181": 0,   // XMC
    "16000": 0,   // CCX
    "20206": 100, // DERO
    "8766" : 101, // RVN
    "8545" : 102, // ETH
    "8645" : 102, // ETC
    "2086" : 1,   // BLOC
    "9053" : 103, // ERG
    "9998" : 104, // RTM
};

const port2algo = {
//  "11181": "k12",           // Aeon
  "11898": "argon2/chukwav2", // TRTL
  "12211": "cn/gpu",        // RYO
  "13007": "cn-pico/trtl",  // IRD
//  "13102": "c29i",          // XTA
  "17750": "cn-heavy/xhv",  // Haven
  "18081": "rx/0",          // XMR
  "18981": "rx/graft",      // Graft
  "19281": "c29v",          // MoneroV
  "19734": "cn/r",          // SUMO
  "19950": "c29s",          // Swap
  "19994": "rx/arq",        // ArqMa
  "11812": "panthera",      // Scala
  "25182": "c29b",          // BitTube
  "33124": "c29s",          // XtendCash
//  "34568": "rx/wow",        // Wownero
  "38081": "cn/half",       // MSR
  "48782": "argon2/chukwav2",         // Lethean
  "9231" : "cn/gpu",        // XEQ
  "20206": "astrobwt/v2",      // DERO
//  "18181": "cn/0",          // XMC
  "16000": "cn/gpu",        // CCX
  "8766" : "kawpow",        // RVN
  "8545" : "ethash",        // ETH
  "8645" : "etchash",       // ETC
  "2086" : "cn-heavy/xhv",  // BLOC
  "9053" : "autolykos2",    // ERG
  "9998" : "ghostrider",    // RTM
};

const mm_nonce_size = cnUtil.get_merged_mining_nonce_size();
const mm_port_set = { };

const fix_daemon_sh = "./fix_daemon.sh";

const extra_nonce_template_hex    = "02" + (pool_nonce_size + 0x100).toString(16).substr(-2) + "00".repeat(pool_nonce_size);
const extra_nonce_mm_template_hex = "02" + (mm_nonce_size + pool_nonce_size + 0x100).toString(16).substr(-2) + "00".repeat(mm_nonce_size + pool_nonce_size);

function get_coin2port(port2coin) {
    let coin2port = {};
    for (let port in port2coin) coin2port[port2coin[port]] = parseInt(port);
    return coin2port;
}
const coin2port = get_coin2port(port2coin);
function get_coins(port2coin) {
    let coins = [];
    for (let port in port2coin) if (port2coin[port] != "") coins.push(port2coin[port]);
    return coins;
}
const ports = Object.keys(port2coin);
const coins = get_coins(port2coin);
function get_mm_child_port_set(mm_port_set) {
    let mm_child_port_set = {};
    for (let port in mm_port_set) {
        const child_port = mm_port_set[port];
        if (!(child_port in mm_child_port_set)) mm_child_port_set[child_port] = {};
        mm_child_port_set[child_port][port] = 1;
    }
    return mm_child_port_set;
}
function get_algos() {
    let algos = {};
    for (let port in port2algo) algos[port2algo[port]] = 1;
    return algos;
}
const all_algos = get_algos();
const mm_child_port_set = get_mm_child_port_set(mm_port_set);

let shareVerifyQueue = [];
let shareVerifyQueueErrorTime = [];
let shareVerifyQueueErrorCount = [];

if (global.config.verify_shares_host) global.config.verify_shares_host.forEach(function(verify_shares_host, index) {
    shareVerifyQueueErrorTime[index]  = 0;
    shareVerifyQueueErrorCount[index] = 0;
    shareVerifyQueue[index] = async.queue(function (task, queueCB) {
        const cb = task.cb;
        if (Date.now() - task.time > 1*60*1000) {
            cb(null);
            return queueCB();
        }
    
        const jsonInput = task.jsonInput;
    
        let socket = new net.Socket();
        let is_cb = false;
        let return_cb = function(result) {
            if (is_cb) return;
            is_cb = true;
            cb(result);
            return queueCB();
        }
        let timer = setTimeout(function() {
            socket.destroy();
            if (shareVerifyQueueErrorCount[index] > 10) {
                const err_str = "Server " + global.config.hostname + " timeouted share verification to " + verify_shares_host;
                console.error(err_str);
                global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't verify share", err_str);
            }
            shareVerifyQueueErrorTime[index] = Date.now();
            ++ shareVerifyQueueErrorCount[index];
            return return_cb(false);
        }, 60*1000);
        socket.connect(2222, verify_shares_host, function () {
            socket.write(JSON.stringify(jsonInput) + "\n");
        });
    
        let buff = "";
        socket.on('data', function (buff1) {
           buff += buff1;
        });
    
        socket.on("end", function () {
            clearTimeout(timer);
            timer = null;
            try {
                const jsonOutput = JSON.parse(buff.toString());
                if (!("result" in jsonOutput)) return return_cb(false);
                shareVerifyQueueErrorCount[index] = 0;
                return return_cb(jsonOutput.result);
            } catch (e) {
                if (shareVerifyQueueErrorCount[index] > 10) {
                    const err_str = "Server " + global.config.hostname + " got wrong JSON from " + verify_shares_host;
                    console.error(err_str);
                    global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't verify share", err_str);
                }
                shareVerifyQueueErrorTime[index] = Date.now();
                ++ shareVerifyQueueErrorCount[index];
                return return_cb(false);
            }
        });
    
        socket.on('error', function() {
            socket.destroy();
            if (shareVerifyQueueErrorCount[index] > 10) {
                const err_str = "Server " + global.config.hostname + " got socket error from " + verify_shares_host;
                console.error(err_str);
                global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't verify share", err_str);
            }
            shareVerifyQueueErrorTime[index] = Date.now();
            ++ shareVerifyQueueErrorCount[index];
            return return_cb(false);
        });
    }, 16);

    setInterval(function(queue_obj, index){
        if (queue_obj.length() >= 1000) {
            let miner_address = {};
            queue_obj.remove(function(task) {
                const d = task.data;
                if (!(d.miner_address in miner_address)) miner_address[d.miner_address] = 1;
                else ++ miner_address[d.miner_address];
                if (Date.now() - d.time > 1*60*1000) {
                   d.cb(null);
                   return true;
                }
                return false;
            });
            console.error(global.database.thread_id + "Share verify queue " + index + " state: " + queue_obj.length() + " items in the queue " + queue_obj.running() + " items being processed");
            Object.keys(miner_address).forEach(function(key) {
                const value = miner_address[key];
                if (value > 100) console.error("Too many shares from " + key + ": " + value);
            });
        }
    }, 30*1000, shareVerifyQueue[index], index);
});

const ETH_BASE_REWARD = 2;
const ETH_MULTIPLIER = 1000000000000000000;

function calcEthReward(block, tx_reciepts) {
    let gas_prices = {};
    block.transactions.forEach(function(tx) {
        gas_prices[tx.hash] = parseInt(tx.gasPrice);
    });
    let fee = 0;
    tx_reciepts.forEach(function(tx) {
        if (tx.result && tx.result.gasUsed) fee += parseInt(tx.result.gasUsed) * gas_prices[tx.result.transactionHash];
    });
    if (block.baseFeePerGas) fee -= parseInt(block.baseFeePerGas) * parseInt(block.gasUsed);
    return (ETH_BASE_REWARD + ETH_BASE_REWARD * (block.uncles.length / 32)) * ETH_MULTIPLIER + fee;
}

function calcErgReward(height, block_tx) {
    let reward = 0;
    if (block_tx.length && block_tx[0].outputs.length == 2 && block_tx[0].outputs[1].creationHeight == height) {
        reward += block_tx[0].outputs[1].value;
        // https://docs.ergoplatform.com/dev/protocol/eip27/
        if (block_tx[0].outputs[1].value >= 15000000000) reward -= 12000000000;
        else reward -= 3000000000;
    }
    if (block_tx.length > 1) {
        const last_tx = block_tx[block_tx.length - 1];
        if (last_tx.outputs.length == 1 && last_tx.outputs[0].creationHeight == height) {
            reward += last_tx.outputs[0].value;
        }
    }
    return reward;
}

function Coin(data){
    this.bestExchange = global.config.payout.bestExchange;
    this.data = data;
    let instanceId = Buffer.alloc(4);
    instanceId.writeUInt32LE( (((global.config.pool_id % (1<<10)) << 22) + (process.pid % (1<<22))) >>> 0 );
    console.log("Generated instanceId: " + instanceId.toString('hex'));
    this.coinDevAddress = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";  // Monero Developers Address
    this.poolDevAddress = "499fS1Phq64hGeqV8p2AfXbf6Ax7gP6FybcMJq6Wbvg8Hw6xms8tCmdYpPsTLSaTNuLEtW4kF2DDiWCFcw4u7wSvFD8wFWE";  // MoneroOcean Address

    this.blockedAddresses = [
        this.coinDevAddress,
        this.poolDevAddress,
        "43SLUTpyTgXCNXsL43uD8FWZ5wLAdX7Ak67BgGp7dxnGhLmrffDTXoeGm2GBRm8JjigN9PTg2gnShQn5gkgE1JGWJr4gsEU", // Wolf0's address
        "42QWoLF7pdwMcTXDviJvNkWEHJ4TXnMBh2Cx6HNkVAW57E48Zfw6wLwDUYFDYJAqY7PLJUTz9cHWB5C4wUA7UJPu5wPf4sZ", // Wolf0's address
        "46gq64YYgCk88LxAadXbKLeQtCJtsLSD63NiEc3XHLz8NyPAyobACP161JbgyH2SgTau3aPUsFAYyK2RX4dHQoaN1ats6iT", // Claymore's Fee Address.
        "47mr7jYTroxQMwdKoPQuJoc9Vs9S9qCUAL6Ek4qyNFWJdqgBZRn4RYY2QjQfqEMJZVWPscupSgaqmUn1dpdUTC4fQsu3yjN"  // Claymore's _other_ fee address.
    ];

    this.exchangeAddresses = [
        "46yzCCD3Mza9tRj7aqPSaxVbbePtuAeKzf8Ky2eRtcXGcEgCg1iTBio6N4sPmznfgGEUGDoBz5CLxZ2XPTyZu1yoCAG7zt6", // Shapeshift.io
        "463tWEBn5XZJSxLU6uLQnQ2iY9xuNcDbjLSjkn3XAXHCbLrTTErJrBWYgHJQyrCwkNgYvyV3z8zctJLPCZy24jvb3NiTcTJ", // Bittrex
        "44TVPcCSHebEQp4LnapPkhb2pondb2Ed7GJJLc6TkKwtSyumUnQ6QzkCCkojZycH2MRfLcujCM7QR1gdnRULRraV4UpB5n4", // Xmr.to
        "47sghzufGhJJDQEbScMCwVBimTuq6L5JiRixD8VeGbpjCTA12noXmi4ZyBZLc99e66NtnKff34fHsGRoyZk3ES1s1V4QVcB", // Poloniex
        "44tLjmXrQNrWJ5NBsEj2R77ZBEgDa3fEe9GLpSf2FRmhexPvfYDUAB7EXX1Hdb3aMQ9FLqdJ56yaAhiXoRsceGJCRS3Jxkn", // Binance.com
        "43c2ykU9i2KZHjV8dWff9HKurYYRkckLueYK96Qh4p1EDoEvdo8mpgNJJpPuods53PM6wNzmj4K2D1V11wvXsy9LMiaYc86", // Changelly.com
        "45rTtwU6mHqSEMduDm5EvUEmFNx2Z6gQhGBJGqXAPHGyFm9qRfZFDNgDm3drL6wLTVHfVhbfHpCtwKVvDLbQDMH88jx2N6w", // ?
        "4ALcw9nTAStZSshoWVUJakZ6tLwTDhixhQUQNJkCn4t3fG3MMK19WZM44HnQRvjqmz4LkkA8t565v7iBwQXx2r34HNroSAZ", // Cryptopia.co.nz
        "4BCeEPhodgPMbPWFN1dPwhWXdRX8q4mhhdZdA1dtSMLTLCEYvAj9QXjXAfF7CugEbmfBhgkqHbdgK9b2wKA6nqRZQCgvCDm", // Bitfinex
        "41xeYWWKwtSiHju5AdyF8y5xeptuRY3j5X1XYHuB1g6ke4eRexA1iygjXqrT3anyZ22j7DEE74GkbVcQFyH2nNiC3gJqjM9", // HitBTC 1
        "43Kg3mcpvaDhHpv8C4UWf7Kw2DAexn2NoRMqqM5cpAtuRgkedDZWjBQjXqrT3anyZ22j7DEE74GkbVcQFyH2nNiC3dx22mZ", // HitBTC 2
	"44rouyxW44oMc1yTGXBUsL6qo9AWWeHETFiimWC3TMQEizSqqZZPnw1UXCaJrCtUC9QT25L5MZvkoGKRxZttvbkmFXA3TMG", // BTC-Alpha 
        "45SLfxvu355SpjjzibLKaChA4NGoTrQAwZmSopAXQa9UXBT63BvreEoYyczTcfXow6eL8VaEG2X6NcTG67XZFTNPLgdR9iM", // some web wallet
    ]; // These are addresses that MUST have a paymentID to perform logins with.

    this.prefix = 18;
    this.subPrefix = 42;
    this.intPrefix = 19;

    if (global.config.general.testnet === true){
        this.prefix = 53;
        this.subPrefix = 63;
        this.intPrefix = 54;
    }

    this.supportsAutoExchange = true;

    this.niceHashDiff = 400000;

    this.getPortBlockHeaderByID = function(port, blockId, callback){
        if (port == 11898) {
            global.support.rpcPortDaemon2(port, 'block/' + blockId, null, function (body) {
                if (body) {
                    return callback(null, body);
                } else {
                    console.error("getPortBlockHeaderByID(" + port + ", " + blockId + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
            });
        } else if (port == 8766 || port == 9998) {
            global.support.rpcPortDaemon2(port, '', { method: 'getblockhash', params: [ blockId ] }, function (body) {
                if (!body || !body.result) {
                    console.error("getPortBlockHeaderByID(" + port + ", " + blockId + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
                return global.coinFuncs.getPortAnyBlockHeaderByHash(port, body.result, false, callback);
            });
        } else if (port == 8545 || port == 8645) {
            const blockId2 = blockId === "latest" ? blockId : "0x" + blockId.toString(16);
            global.support.rpcPortDaemon2(port, '', { jsonrpc: "2.0", id: 1, method: 'eth_getBlockByNumber', params: [ blockId2, true ] }, function (body) {
                if (!body || !body.result) {
                    console.error("getPortBlockHeaderByID(" + port + ", " + blockId + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
                body.result.height = parseInt(body.result.number);
                if (blockId === "latest") return callback(null, body.result); // do not need rewards for the latest block
                let batch_getBlockReceipts = [];
                body.result.transactions.forEach(function(tx) {
                    batch_getBlockReceipts.push({ jsonrpc: "2.0", id: 1, method: 'eth_getTransactionReceipt', params: [ tx.hash ] });
                });
                if (!batch_getBlockReceipts.length) {
                    body.result.reward = calcEthReward(body.result, []);
                    return callback(null, body.result);
                }
                global.support.rpcPortDaemon2(port, '', batch_getBlockReceipts, function (body2) {
                    if (!body2 || !(body2 instanceof Array)) {
                        console.error("getPortBlockHeaderByID(" + port + ", " + blockId + "): " + JSON.stringify(body2));
                        return callback(true, body2);
                    }
                    body.result.reward = calcEthReward(body.result, body2);
                    return callback(null, body.result);
                });
            });
        } else if (port == 9053) {
            global.support.rpcPortDaemon2(port, 'blocks/at/' + blockId, null, function (body) {
                if (!body || !(body instanceof Array) || body.length != 1) {
                    console.error("getPortBlockHeaderByID(" + port + ", " + blockId + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
                return global.coinFuncs.getPortAnyBlockHeaderByHash(port, body[0], false, callback);
            });
        } else {
            global.support.rpcPortDaemon(port, 'getblockheaderbyheight', {"height": blockId}, function (body) {
                if (body && body.hasOwnProperty('result')) {
                    if (port == 20206) { // DERO is special here
                        body.result.block_header.timestamp /= 1000;
                        body.result.block_header.difficulty *= 18;
                    }
                    return callback(null, body.result.block_header);
                } else {
                    console.error("getPortBlockHeaderByID(" + port + ", " + blockId + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
            });

        }
    };

    this.getBlockHeaderByID = function(blockId, callback){
        return this.getPortBlockHeaderByID(global.config.daemon.port, blockId, callback);
    };

    this.getPortAnyBlockHeaderByHash = function(port, blockHash, is_our_block, callback){
        // TRTL/IRD does not get getblock LTHN / AEON / DERO have composite tx
        if (port == 11898) {
            global.support.rpcPortDaemon2(port, 'block/' + blockHash, null, function (body) {
                if (typeof(body) === 'undefined') {
                    console.error("getPortBlockHeaderByHash(" + port + ", " + blockHash + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
                return callback(null, body);
            });
        } else if (port == 8766 || port == 9998) {
            global.support.rpcPortDaemon2(port, '', { method: 'getblock', params: [ blockHash ] }, function (body) {
                if (!body || !body.result) {
                    console.error("getPortBlockHeaderByHash(" + port + ", " + blockHash + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
                body.result.reward = (port == 8766 ? 2500 : 3750) * 100000000;
                if (port == 9998) body.result.difficulty *= 0xFFFFFFFF;
                return callback(null, body.result);
            });
        } else if (port == 8545 || port == 8645) {
            global.support.rpcPortDaemon2(port, '', { jsonrpc: "2.0", id: 1, method: 'eth_getBlockByHash', params: [ "0x" + blockHash, true ] }, function (body) {
                if (!body || !body.result) {
                    console.error("getPortBlockHeaderByHash(" + port + ", " + blockHash + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
                body.result.height = parseInt(body.result.number);
                global.coinFuncs.getPortBlockHeaderByID(port, body.result.height, function(err, body_height) {
                    if (err) return callback(true, body);
                    if (body.result.hash === body_height.hash) {
                        let batch_getBlockReceipts = [];
                        body.result.transactions.forEach(function(tx) {
                            batch_getBlockReceipts.push({ jsonrpc: "2.0", id: 1, method: 'eth_getTransactionReceipt', params: [ tx.hash ] });
                        });
                        if (!batch_getBlockReceipts.length) {
                            body.result.reward = calcEthReward(body.result, []);
                            return callback(null, body.result);
                        }
                        global.support.rpcPortDaemon2(port, '', batch_getBlockReceipts, function (body2) {
                            if (!body2 || !(body2 instanceof Array)) {
                                console.error("getPortBlockHeaderByHash(" + port + ", " + blockHash + "): " + JSON.stringify(body2));
                                return callback(true, body2);
                            }
                            body.result.reward = calcEthReward(body.result, body2);
                            return callback(null, body.result);
                        });

                    // uncle block?
                    } else async.eachSeries(Array(16).fill().map((element, index) => body.result.height + index - 7), function(block_height, next) {
                        global.coinFuncs.getPortBlockHeaderByID(port, block_height, function(err, body_height) {
                            if (err) {
                                if (is_our_block) return next(false); // need to wait for more blocks before it will be reported as uncle
                                return next(null);
                            }
                            const uncleIndex = body_height.uncles.indexOf("0x" + blockHash);
                            if (uncleIndex === -1) return next(null);
                            global.support.rpcPortDaemon2(port, '', { jsonrpc: "2.0", id: 1, method: 'eth_getUncleByBlockNumberAndIndex', params: [ "0x" + block_height.toString(16), "0x" + uncleIndex.toString(16) ] }, function (body_uncle) {
                                if (!body_uncle || !body_uncle.result) {
                                    console.error("eth_getUncleByBlockNumberAndIndex(0x" + block_height.toString(16) + ", 0x" + uncleIndex.toString(16) + "): " + JSON.stringify(body_uncle));
                                    return next(null);
                                }
                                return next((ETH_BASE_REWARD * (8 - (parseInt(body_height.number) - parseInt(body_uncle.result.number))) / 8) * ETH_MULTIPLIER);
                            });
                        });
                    }, function(uncleReward) {
                        if (uncleReward === false) return callback(true, body);
                        body.result.reward = uncleReward ? uncleReward : null;
                        return callback(null, body.result);
                    });
                });
            });
        } else if (port == 9053) {
            global.support.rpcPortDaemon2(port, 'blocks/' + blockHash, null, function (body) {
                if (!body || !body.header) {
                    console.error("getPortBlockHeaderByHash(" + port + ", " + blockHash + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
                body.header.reward = calcErgReward(body.header.height, body.blockTransactions.transactions);
                return callback(null, body.header);
            });
        } else if (port == 13007 || port == 2086 || port == 48782 || port == 11181 || port == 20206 || port == 16000) {
            global.support.rpcPortDaemon(port, 'getblockheaderbyhash', {"hash": blockHash}, function (body) {
                if ( typeof(body) === 'undefined' || !body.hasOwnProperty('result') ) {
                    console.error("getPortBlockHeaderByHash(" + port + ", " + blockHash + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
                return callback(null, body.result.block_header);
            });
        } else global.support.rpcPortDaemon(port, 'getblock', {"hash": blockHash}, function (body) {
            if (typeof(body) === 'undefined' || !body.hasOwnProperty('result')) {
                console.error("getPortBlockHeaderByHash(" + port + ", " + blockHash + "): " + JSON.stringify(body));
                return callback(true, body);
            }

            body.result.block_header.reward = 0;
            if (port == 20206) { // DERO is special here
                body.result.block_header.timestamp /= 1000;
                body.result.block_header.difficulty *= 18;
            }

            let reward_check = 0;
            const blockJson = JSON.parse(body.result.json);
            const minerTx = blockJson.miner_tx;

            if (port == 17750 || port == 33124 || port == 25182 || port == 18181) { // XHV / XtendCash / TUBE / Italocoin / XMC has reward as zero transaction
                reward_check = minerTx.vout[0].amount;
            } else {
                for (var i=0; i<minerTx.vout.length; i++) {
                    if (minerTx.vout[i].amount > reward_check) {
                        reward_check = minerTx.vout[i].amount;
                    }
                }
            }
            const miner_tx_hash = body.result.miner_tx_hash == "" ? body.result.block_header.miner_tx_hash : body.result.miner_tx_hash;

            if (is_our_block && body.result.hasOwnProperty('miner_tx_hash')) global.support.rpcPortWalletShort(port + 1, "get_transfer_by_txid", {"txid": miner_tx_hash}, function (body2) {
                if (typeof(body2) === 'undefined' || body2.hasOwnProperty('error') || !body2.hasOwnProperty('result') || !body2.result.hasOwnProperty('transfer') || !body2.result.transfer.hasOwnProperty('amount')) {
                    console.error(port + ": block hash: " + blockHash + ": txid " + miner_tx_hash + ": " + JSON.stringify(body2));
                    return callback(true, body.result.block_header);
                }
                let reward = body2.result.transfer.amount;
                if (port == 17750) {
                   body2.result.transfers.forEach(function(transfer) { if (transfer.asset_type === "XHV") reward = transfer.amount; });
                }

                if (reward !== reward_check) {
                    if (reward_check < reward) {
                        console.warn(port + ": block hash: " + blockHash + ": txid " + miner_tx_hash + ": using lesser block reward from block header " + reward_check + " instead of higher from incoming wallet tx " + reward);
                        reward = reward_check;
                    } else {
                        console.warn(port + ": block hash: " + blockHash + ": txid " + miner_tx_hash + ": using lesser block reward from incoming tx " + reward + " instead of higher from block header " + reward_check);
                    }
                }
                if (port != 38081 && reward == 0) { // MSR can have uncle block reward here
                    console.error(port + ": block hash: " + blockHash + ": txid " + miner_tx_hash + ": both block header and incoming wallet tx rewards are zero: " + JSON.stringify(body) + "\n" + JSON.stringify(body2));
                    return callback(true, body);
                }

                body.result.block_header.reward = reward;
                return callback(null, body.result.block_header);

            }); else {
                body.result.block_header.reward = reward_check;
                return callback(null, body.result.block_header);
            }
        }); 
    };

    this.getPortBlockHeaderByHash = function(port, blockHash, callback){
        return this.getPortAnyBlockHeaderByHash(port, blockHash, true, callback);
    };

    this.getBlockHeaderByHash = function(blockHash, callback){
        return this.getPortBlockHeaderByHash(global.config.daemon.port, blockHash, callback);
    };

    this.getPortLastBlockHeader = function(port, callback, no_error_report) {
        if (port == 11898) {
            global.support.rpcPortDaemon2(port, 'block/last', null, function (body) {
                if (typeof(body) === 'object') {
                    return callback(null, body);
                } else {
                    if (!no_error_report) console.error("Last block header invalid: " + JSON.stringify(body));
                    return callback(true, body);
                }
            });
        } else if (port == 8766 || port == 9998) {
            global.support.rpcPortDaemon2(port, '', { method: 'getbestblockhash' }, function (body) {
                if (!body || !body.result) {
                    console.error("getPortLastBlockHeader(" + port + "): " + JSON.stringify(body));
                    return callback(true, body);
                }
                if (global.coinFuncs.lastRavenBlockHash === body.result) return callback(null, global.coinFuncs.lastRavenBlock);
                global.coinFuncs.getPortAnyBlockHeaderByHash(port, body.result, false, function (err, body2) {
                    if (err === null) {
                        global.coinFuncs.lastRavenBlockHash = body.result;
                        global.coinFuncs.lastRavenBlock = body2;
                    }
                    return callback(err, body2);
                });
            });
        } else if (port == 8545 || port == 8645) {
            global.support.rpcPortDaemon2(port, '', { jsonrpc: "2.0", id: 1, method: "eth_getWork", "params": [] }, function(body) {
	        if (!body || !body.result || !(body.result instanceof Array)) return callback(true, body);
		const bt = cnUtil.EthBlockTemplate(body.result);
		return callback(null, { hash: bt.hash, timestamp: Date.now() / 1000, difficulty: bt.difficulty, height: bt.height, seed_hash: bt.seed_hash });
            });
        } else if (port == 9053) {
            global.support.rpcPortDaemon2(port, 'mining/candidate', null, function(body) {
	        if (!body || !body.pk) return callback(true, body);
		const bt = cnUtil.ErgBlockTemplate(body);
		return callback(null, { hash: bt.hash, timestamp: Date.now() / 1000, difficulty: bt.difficulty, height: bt.height, hash2: bt.hash2 });
            });
        } else {
            global.support.rpcPortDaemon(port, 'getlastblockheader', [], function (body) {
                if (typeof(body) !== 'undefined' && body.hasOwnProperty('result')) {
                    if (port == 20206) { // DERO is special here
                        body.result.block_header.timestamp /= 1000;
                        body.result.block_header.difficulty *= 18;
                    }
                    return callback(null, body.result.block_header);
                } else {
                    if (!no_error_report) console.error("Last block header invalid: " + JSON.stringify(body));
                    return callback(true, body);
                }
            });
        }
    };

    this.getLastBlockHeader = function(callback) {
        return this.getPortLastBlockHeader(global.config.daemon.port, callback);
    };

    this.getPortBlockTemplate = function(port, callback) {
        if (port == 11898) {
            global.support.rpcPortDaemon2(port, 'block/template', {
                address: global.config.pool["address_" + port.toString()],
                reserveSize: port in mm_port_set ? mm_nonce_size + pool_nonce_size : pool_nonce_size
            }, function(body) {
                return callback(body ? body : null);
            });

        } else if (port == 8766 || port == 9998) {
            global.support.rpcPortDaemon2(port, '', {
		method: 'getblocktemplate',
                params: [{
                    capabilities: [ "coinbasetxn", "workid", "coinbase/append" ], 
                    rules: [ "segwit" ]
                }]
            }, function(body) {
                if (body && body.result) switch (parseInt(port)) {
                  case 8766: return callback(cnUtil.RavenBlockTemplate(body.result, global.config.pool["address_" + port.toString()]));
                  case 9998: return callback(cnUtil.RtmBlockTemplate(body.result, global.config.pool["address_" + port.toString()]));
                } else return callback(null);
            });

        } else if (port == 8545 || port == 8645) {
            global.support.rpcPortDaemon2(port, '', { jsonrpc: "2.0", id: 1, method: "eth_getWork", "params": [] }, function(body) {
                return callback(body && body.result ? cnUtil.EthBlockTemplate(body.result) : null);
            });

        } else if (port == 9053) {
            global.support.rpcPortDaemon2(port, 'mining/candidate', null, function(body) {
                return callback(body && body.pk ? cnUtil.ErgBlockTemplate(body) : null);
            });


        } else {
            global.support.rpcPortDaemon(port, 'getblocktemplate', {
                reserve_size: port in mm_port_set ? mm_nonce_size + pool_nonce_size : pool_nonce_size,
                wallet_address: global.config.pool[port == global.config.daemon.port ? "address" : "address_" + port.toString()]
            }, function(body){
                if (body && body.result && port == 20206) { // DERO is special here
                  body.result.timestamp /= 1000;
                  body.result.difficulty *= 18;
                  body.result.mbl_difficulty = body.result.blockhashing_blob.charAt(0) == '4' ? body.result.difficulty : body.result.difficulty * 9;
                  body.result.reserved_offset = 36;
                  body.result.prev_hash = body.result.blockhashing_blob; // need to keep prev_hash different for miniblocks or BT update will be ignored in pool.js
                }
                return callback(body && body.result ? body.result : null);
            });
        }
    };

    this.getBlockTemplate = function(callback){
        return this.getPortBlockTemplate(global.config.daemon.port, callback);
    };


    this.ethBlockCheck = function(port, miner_hex, nonce_hex, block_height_hex, callback) {
        global.support.rpcPortDaemon2(port, '', { jsonrpc: "2.0", id: 1, method: 'eth_getBlockByNumber', params: [ block_height_hex, true ] }, function (body) {
            if (!body || !body.result) {
                console.error("getPortBlockHeaderByID(" + port + ", " + block_height_hex + "): " + JSON.stringify(body));
                return callback(null, null);
            }
            if (body.result.miner === miner_hex && body.result.nonce == nonce_hex) return callback(body.result.hash);
            block_height_hex = body.result.number;
            async.eachSeries(Array(body.result.uncles.length).fill().map((element, index) => index), function(index, next) {
                global.support.rpcPortDaemon2(port, '', { jsonrpc: "2.0", id: 1, method: 'eth_getUncleByBlockNumberAndIndex', params: [ block_height_hex, "0x" + index.toString(16) ] }, function (body_uncle) {
                    if (!body_uncle || !body_uncle.result) {
                        console.error("eth_getUncleByBlockNumberAndIndex(0x" + block_height_hex + ", 0x" + index.toString(16) + "): " + JSON.stringify(body_uncle));
                        return next(null);
                    }
                    return next(body_uncle.result.miner === miner_hex && body_uncle.result.nonce == nonce_hex ? body_uncle.result.hash : null);
                });
            }, function(block_hash) {
                const block_height = parseInt(block_height_hex);
                return callback(block_hash, block_height);
            });
        });
    };

    this.ethBlockFind = function(port, nonce_hex, callback) {
        const miner_hex = global.config.pool["address_" + port];
        global.coinFuncs.ethBlockCheck(port, miner_hex, nonce_hex, "latest", function(block_hash, block_height) {
            if (block_hash) return callback(block_hash);
            if (!block_height) return callback(null);
            async.eachSeries(Array(32).fill().map((element, index) => block_height - index - 1), function(block_height, next) {
                global.coinFuncs.ethBlockCheck(port, miner_hex, nonce_hex, "0x" + block_height.toString(16), function(block_hash) {
                    return next(block_hash);
                });
            }, function(block_hash) {
                return callback(block_hash);
            });
        });
    };

    this.baseDiff = cnUtil.baseDiff;
    this.baseRavenDiff = cnUtil.baseRavenDiff;

    this.validatePlainAddress = function(address){
        // This function should be able to be called from the async library, as we need to BLOCK ever so slightly to verify the address.
        address = Buffer.from(address);
        let code = cnUtil.address_decode(address);
        return code === this.prefix || code === this.subPrefix;
    };

    this.validateAddress = function(address){
        if (this.validatePlainAddress(address)) return true;
        // This function should be able to be called from the async library, as we need to BLOCK ever so slightly to verify the address.
        address = Buffer.from(address);
        return cnUtil.address_decode_integrated(address) === this.intPrefix;
    };

    this.portBlobType = function(port, version) { return port2blob_num[port]; }

    this.blobTypeGrin = function(blob_type_num) {
        switch (blob_type_num) {
            case 8:
            case 9:
            case 10:
            case 12: return true;
            default: return false;
        }
    }

    this.c29ProofSize = function(blob_type_num) {
        switch (blob_type_num) {
            case 10: return 40;
            case 12: return 48;
            default: return 32;
        }
    }

    this.nonceSize = function(blob_type_num) {
        switch (blob_type_num) {
            case 7:
            case 101:           // RVN
            case 102:           // ETH
            case 103: return 8; // ERG
            default:  return 4;
        }
    }

    this.blobTypeDero = function(blob_type_num) { return blob_type_num == 100; }

    this.blobTypeRvn  = function(blob_type_num) { return blob_type_num == 101; }

    this.blobTypeEth  = function(blob_type_num) { return blob_type_num == 102; }

    this.blobTypeErg  = function(blob_type_num) { return blob_type_num == 103; }

    this.blobTypeRtm  = function(blob_type_num) { return blob_type_num == 104; }

    this.convertBlob = function(blobBuffer, port) {
        const blob_type_num = this.portBlobType(port, blobBuffer[0]);
        if (this.blobTypeDero(blob_type_num)) return blobBuffer;
        let blob;
        try {
            if (this.blobTypeRvn(blob_type_num)) {
                blob = cnUtil.convertRavenBlob(blobBuffer);
            } else if (this.blobTypeRtm(blob_type_num)) {
                blob = cnUtil.convertRtmBlob(blobBuffer);
            } else {
                blob = cnUtil.convert_blob(blobBuffer, blob_type_num);
            }
        } catch (e) {
            const err_str = "Can't do port " + port + " convert_blob " + blobBuffer.toString('hex') + " with blob type " + blob_type_num + ": " + e;
            console.error(err_str);
            global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't convert_blob", err_str);
            return null;
        }
        return blob;
    };

    this.constructNewBlob = function(blockTemplate, params, port) {
        const blob_type_num = this.portBlobType(port, blockTemplate[0]);
        if (global.coinFuncs.blobTypeGrin(blob_type_num)) {
            return cnUtil.construct_block_blob(blockTemplate,
                bignum(params.nonce, 10).toBuffer({endian: 'little', size: 4}),
                blob_type_num, params.pow
            );
        } else if (global.coinFuncs.blobTypeDero(blob_type_num)) {
            return cnUtil.constructNewDeroBlob(blockTemplate, Buffer.from(params.nonce, 'hex'));
        } else if (global.coinFuncs.blobTypeRvn(blob_type_num)) {
            return cnUtil.constructNewRavenBlob(blockTemplate,
                bignum(params.nonce, 16).toBuffer({endian: 'little', size: 8}),
                bignum(params.mixhash, 16).toBuffer({endian: 'little', size: 32})
            );
        } else if (global.coinFuncs.blobTypeRtm(blob_type_num)) {
            return cnUtil.constructNewRtmBlob(blockTemplate, Buffer.from(params.nonce, 'hex'));
        } else {
            return cnUtil.construct_block_blob(blockTemplate, Buffer.from(params.nonce, 'hex'), blob_type_num);
        }
    };

    this.constructMMParentBlockBlob = function(parentTemplateBuffer, port, childTemplateBuffer) {
        //console.log("MERGED MINING: constructMMParentBlockBlob");
        return cnUtil.construct_mm_parent_block_blob(parentTemplateBuffer, this.portBlobType(port, parentTemplateBuffer[0]), childTemplateBuffer);
    };

    this.constructMMChildBlockBlob = function(shareBuffer, port, childTemplateBuffer) {
        console.log("MERGED MINING: constructMMChildBlockBlob");
        return cnUtil.construct_mm_child_block_blob(shareBuffer, this.portBlobType(port, shareBuffer[0]), childTemplateBuffer);
    };

    this.getBlockID = function(blockBuffer, port){
        const blob_type_num = this.portBlobType(port, blockBuffer[0]);
        if (global.coinFuncs.blobTypeRtm(blob_type_num)) {
            return cnUtil.blockHashBuff(cnUtil.convertRtmBlob(blockBuffer));
        } else {
            return cnUtil.get_block_id(blockBuffer, blob_type_num);
        }
    };

    this.BlockTemplate = function(template) {
        // Generating a block template is a simple thing.  Ask for a boatload of information, and go from there.
        // Important things to consider.
        // The reserved space is 16 bytes long now in the following format:
        // Assuming that the extraNonce starts at byte 130:
        // |130-133|134-137|138-141|142-145|
        // |minerNonce/extraNonce - 4 bytes|instanceId - 4 bytes|clientPoolNonce - 4 bytes|clientNonce - 4 bytes|
        // This is designed to allow a single block template to be used on up to 4 billion poolSlaves (clientPoolNonce)
        // Each with 4 billion clients. (clientNonce)
        // While being unique to this particular pool thread (instanceId)
        // With up to 4 billion clients (minerNonce/extraNonce)
        // Overkill? Sure. But that's what we do here. Overkill.

        // Set these params equal to values we get from upstream (if they are set)
        // DERO-HE case, where mbl is miniblock
        this.difficulty         = template.mbl_difficulty ? template.mbl_difficulty : template.difficulty;
        this.height             = template.height;
        this.bits               = template.bits;
        this.seed_hash          = template.seed_hash;
        this.coin               = template.coin;
        this.port               = template.port;

        const port_blob_num  = port2blob_num[this.port];

        if (template.blocktemplate_blob) {
            this.blocktemplate_blob = template.blocktemplate_blob;
        } else if (template.blob) {
            this.blocktemplate_blob = template.blob;
        } else {
            const isExtraNonceBT = global.coinFuncs.blobTypeEth(port_blob_num) || global.coinFuncs.blobTypeErg(port_blob_num);
            if (isExtraNonceBT) {
                const hash = template.hash;
                this.hash          = this.idHash = this.prev_hash = hash;
                this.hash2         = template.hash2;
                this.block_version = 0;
                this.nextBlobHex   = function () { return hash; };
                return;
            } else {
                console.error("INTERNAL ERROR: No blob in " + this.port + " port block template: " + JSON.stringify(template));
                this.blocktemplate_blob = extra_nonce_mm_template_hex; // to avoid hard crash
            }
        }

        const is_mm = "child_template" in template;

        if (is_mm) {
            this.child_template        = template.child_template;
            this.child_template_buffer = template.child_template_buffer;
        }

        const is_dero = global.coinFuncs.blobTypeDero(port_blob_num);
        const blob = is_dero ? template.blockhashing_blob : (is_mm ? template.parent_blocktemplate_blob : this.blocktemplate_blob);

        this.idHash = crypto.createHash('md5').update(blob).digest('hex');

        // Set this.buffer to the binary decoded version of the BT blob
        this.buffer = Buffer.from(blob, 'hex');
        this.block_version = this.buffer[0];

        if (global.coinFuncs.blobTypeRvn(port_blob_num) || global.coinFuncs.blobTypeRtm(port_blob_num)) {
            this.reserved_offset = template.reserved_offset;
        } else if (is_dero) { // exception for DERO
            this.reserved_offset = template.reserved_offset;
        } else {
            const template_hex = (template.port in mm_port_set && !is_mm) ? extra_nonce_mm_template_hex : extra_nonce_template_hex;
            const found_reserved_offset_template = blob.indexOf(template_hex);

            if (found_reserved_offset_template !== -1) {
                const found_reserved_offset = (found_reserved_offset_template >> 1) + 2;
                if (is_mm) {
                    this.reserved_offset = found_reserved_offset;
                } else {
                    if (template.reserved_offset) {
                        // here we are OK with +1 difference because we put extra byte into pool_nonce_size
                        if (found_reserved_offset != template.reserved_offset && found_reserved_offset + 1 != template.reserved_offset) {
                            console.error("INTERNAL ERROR: Found reserved offset " + found_reserved_offset + " do not match " + template.reserved_offset + " reported by daemon in " + this.port + " block " + ": " + blob);
                        }
                        this.reserved_offset = template.reserved_offset;
                    } else if (template.reservedOffset) {
                        // here we are OK with +1 difference because we put extra byte into pool_nonce_size
                        if (found_reserved_offset != template.reservedOffset && found_reserved_offset + 1 != template.reservedOffset) {
                            console.error("INTERNAL ERROR: Found reserved offset " + found_reserved_offset + " do not match " + template.reservedOffset + " reported by daemon in " + this.port + " block " + ": " + blob);
                        }
                        this.reserved_offset = template.reservedOffset;
                    } else {
                        this.reserved_offset = found_reserved_offset;
                    }
                }
            } else {
                //console.error("INTERNAL ERROR: Can not find reserved offset template '" + template_hex + "' in " + this.port + " block " + ": " + blob);
                this.reserved_offset = template.reserved_offset ? template.reserved_offset : template.reservedOffset;
            }
        }

        if (!this.reserved_offset) {
            console.error("INTERNAL ERROR: No reserved offset in " + this.port + " port block template: " + JSON.stringify(template));
            this.reserved_offset = 0; // to avoid hard crash
        }

        if (!("prev_hash" in template)) {  // Get prev_hash from blob
            let prev_hash = Buffer.alloc(32);
            const prev_hash_start = global.coinFuncs.blobTypeRvn(port2blob_num[this.port]) ? 4 : 7;
            this.buffer.copy(prev_hash, 0, prev_hash_start, prev_hash_start + 32);
            this.prev_hash = prev_hash.toString('hex');
        } else {
            this.prev_hash = template.prev_hash;
        }

        // Copy the Instance ID to the reserve offset + 4 bytes deeper.  Copy in 4 bytes.
        instanceId.copy(this.buffer, this.reserved_offset + 4, 0, 4);
        // Reset the Nonce - this is the per-miner/pool nonce
        this.extraNonce = 0;
        // The clientNonceLocation is the location at which the client pools should set the nonces for each of their clients.
        this.clientNonceLocation = this.reserved_offset + 12;
        // The clientPoolLocation is for multi-thread/multi-server pools to handle the nonce for each of their tiers.
        this.clientPoolLocation = this.reserved_offset + 8;

        this.nextBlobHex = function () {
            // Write a 32 bit integer, big-endian style to the 0 byte of the reserve offset.
            this.buffer.writeUInt32BE(++this.extraNonce, this.reserved_offset);
            // Convert the buffer into something hashable.
            const blob = global.coinFuncs.convertBlob(this.buffer, this.port);
            return blob ? blob.toString('hex') : null;
        };
        // Make it so you can get the raw block buffer out.
        this.nextBlobWithChildNonceHex = function () {
            // Write a 32 bit integer, big-endian style to the 0 byte of the reserve offset.
            this.buffer.writeUInt32BE(++this.extraNonce, this.reserved_offset);
            // Don't convert the buffer to something hashable.  You bad.
            return this.buffer.toString('hex');
        };
    };

    this.getPORTS          = function() { return ports; }
    this.getCOINS          = function() { return coins; }
    this.PORT2COIN         = function(port) { return port2coin[port]; }
    this.PORT2COIN_FULL    = function(port) { const coin = port2coin[port]; return coin == "" ? "XMR" : coin; }
    this.COIN2PORT         = function(coin) { return coin2port[coin]; }
    this.getMM_PORTS       = function() { return mm_port_set; }
    this.getMM_CHILD_PORTS = function() { return mm_child_port_set; }

    this.getDefaultAlgos = function() {
        return [ "rx/0" ];
    }

    this.getDefaultAlgosPerf = function() {
        return { "rx/0": 1 };
    }

    this.getPrevAlgosPerf = function() {
        return { "cn/r": 1, "cn/half": 1.9, "cn/rwz": 1.3, "cn/zls": 1.3, "cn/double": 0.5 };
    }

    this.convertAlgosToCoinPerf = function(algos_perf) {
        let coin_perf = {};

        if      ("rx/0" in algos_perf)          coin_perf[""]     = algos_perf["rx/0"];

        if      ("cn/r" in algos_perf)          coin_perf["SUMO"] = algos_perf["cn/r"];

        if      ("cn/half" in algos_perf)       coin_perf["MSR"]  = algos_perf["cn/half"];
        else if ("cn/fast2" in algos_perf)      coin_perf["MSR"]  = algos_perf["cn/fast2"];

        if      ("panthera" in algos_perf)      coin_perf["XLA"]  = algos_perf["panthera"];

        if      ("cn/gpu" in algos_perf)        coin_perf["RYO"]  = coin_perf["CCX"] = coin_perf["XEQ"] = algos_perf["cn/gpu"];

//        if      ("rx/wow" in algos_perf)        coin_perf["WOW"]  = algos_perf["rx/wow"];

        if      ("kawpow" in algos_perf)        coin_perf["RVN"]  = algos_perf["kawpow"];

        if      ("ghostrider" in algos_perf)    coin_perf["RTM"]  = algos_perf["ghostrider"];

        if      ("ethash" in algos_perf)        coin_perf["ETC"]  = algos_perf["ethash"];
        if      ("etchash" in algos_perf)       coin_perf["ETC"]  = algos_perf["etchash"];

        if      ("autolykos2" in algos_perf)    coin_perf["ERG"]  = algos_perf["autolykos2"];

        if      ("rx/graft" in algos_perf)      coin_perf["GRFT"] = algos_perf["rx/graft"];

        if      ("cn-heavy/xhv" in algos_perf)  coin_perf["XHV"]  = coin_perf["BLOC"] = algos_perf["cn-heavy/xhv"];

        //if      ("k12" in algos_perf)           coin_perf["AEON"] = algos_perf["k12"];

        if      ("cn-pico"      in algos_perf)  coin_perf["IRD"]  = algos_perf["cn-pico"];
        else if ("cn-pico/trtl" in algos_perf)  coin_perf["IRD"]  = algos_perf["cn-pico/trtl"];

        if      ("rx/arq"      in algos_perf)   coin_perf["ARQ"]  = algos_perf["rx/arq"];

        if      ("c29s" in algos_perf)          coin_perf["XTNC"] = coin_perf["XWP"] = algos_perf["c29s"];
        if      ("c29v" in algos_perf)          coin_perf["XMV"]  = algos_perf["c29v"];
        if      ("c29b" in algos_perf)          coin_perf["TUBE"] = algos_perf["c29b"];

        //if      ("astrobwt/v2" in algos_perf)   coin_perf["DERO"] = algos_perf["astrobwt/v2"];

        //if      ("cn/0" in algos_perf)          coin_perf["XMC"] = algos_perf["cn/0"];

        if      ("argon2/chukwav2" in algos_perf) coin_perf["TRTL"] = coin_perf["LTHN"] = algos_perf["argon2/chukwav2"];
        else if ("chukwav2" in algos_perf)        coin_perf["TRTL"] = coin_perf["LTHN"] = algos_perf["chukwav2"];

        return coin_perf;
    }

    // returns true if algo set reported by miner is for main algo
    this.algoMainCheck = function(algos) {
        if ("rx/0" in algos) return true;
        return false;
    }
    // returns true if algo set reported by miner is one of previous main algos
    this.algoPrevMainCheck = function(algos) {
        if ("cn/r" in algos) return true;
        return false;
    }
    // returns true if algo set reported by miner is OK or error string otherwise
    this.algoCheck = function(algos) {
        if (this.algoMainCheck(algos)) return true;
        for (let algo in all_algos) if (algo in algos) return true;
        return "algo array must include at least one supported pool algo: [" + Object.keys(algos).join(", ") + "]";
    }

    this.slowHashBuff = function(convertedBlob, blockTemplate, nonce, mixhash) {
        switch (blockTemplate.port) {
            case 2086:  return multiHashing.cryptonight_heavy(convertedBlob, 1);				   	   // BLOC
            case 8766:  return multiHashing.kawpow(convertedBlob, Buffer.from(nonce, 'hex'), Buffer.from(mixhash, 'hex')); // RVN
            case 9998:  return multiHashing.cryptonight(convertedBlob, 18);                                                // RTM
            case 8545:  return multiHashing.ethash(convertedBlob, Buffer.from(nonce, 'hex'), blockTemplate.height);        // ETH
            case 8645:  return multiHashing.etchash(convertedBlob, Buffer.from(nonce, 'hex'), blockTemplate.height);       // ETC
            case 9053:  return multiHashing.autolykos2_hashes(convertedBlob, blockTemplate.height);                        // ERG
            case 9231 : return multiHashing.cryptonight(convertedBlob, 11);						   // XEQ
            //case 11181: return multiHashing.k12(convertedBlob);  							   // Aeon
            case 11898: return multiHashing.argon2(convertedBlob, 2);						           // TRTL
            case 12211: return multiHashing.cryptonight(convertedBlob, 11);						   // RYO
	    case 13007: return multiHashing.cryptonight_pico(convertedBlob, 0);					    	   // Iridium
            case 16000: return multiHashing.cryptonight(convertedBlob, 11);			                           // CCX
            case 17750: return multiHashing.cryptonight_heavy(convertedBlob, 1);					   // Haven
            case 18081: return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, 'hex'), 0);	   // XMR
            //case 18181: return multiHashing.cryptonight(convertedBlob, 0);						   // XMC
            case 18981: return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, 'hex'), 20);       // Graft
            case 19734: return multiHashing.cryptonight(convertedBlob, 13, blockTemplate.height);			   // SUMO
	    case 19994: return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, 'hex'), 2);	   // ArqMa
            case 11812: return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, 'hex'), 3);        // Scala
            case 20206: return multiHashing.astrobwt(convertedBlob, 1);                                                    // Dero
//            case 34568: return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, 'hex'), 17);	   // Wownero
            case 38081: return multiHashing.cryptonight(convertedBlob, 9);       					   // MSR
            case 48782: return multiHashing.argon2(convertedBlob, 2);	                                 		   // Lethean
            default:
		console.error("Unknown " + blockTemplate.port + " port for Cryptonight PoW type");
		return multiHashing.cryptonight(convertedBlob, 13, blockTemplate.height);
        }
    }

    this.slowHash = function(convertedBlob, blockTemplate, nonce, mixhash) {
        return this.slowHashBuff(convertedBlob, blockTemplate, nonce, mixhash).toString("hex");
    }

    this.verify_share_host_index = 0;

    this.slowHashAsync = function(convertedBlob, blockTemplate, miner_address, cb) {
        if (!global.config.verify_shares_host) return cb(this.slowHash(convertedBlob, blockTemplate));
        let jsonInput;
        switch (blockTemplate.port) {
            case 18081:
            case 18981:
	    case 19994:
            case 11812:
            case 22023:
//            case 34568:
                jsonInput = { "algo": port2algo[blockTemplate.port], "blob": convertedBlob.toString('hex'), "seed_hash": blockTemplate.seed_hash };
                break;
            case 19734:
                jsonInput = { "algo": port2algo[blockTemplate.port], "blob": convertedBlob.toString('hex'), "height": blockTemplate.height };
                break;
            //case 11181:
            //    return cb(this.slowHash(convertedBlob, blockTemplate)); // AEON K12 is too fast
            default:
                jsonInput = { "algo": port2algo[blockTemplate.port], "blob": convertedBlob.toString('hex') };
        }
        const time_now     = Date.now();
        let best_index     = null;
        let min_queue_size = null;
        let max_noerr_time = null;
        shareVerifyQueue.forEach(function(queue_obj, index) {
            if (time_now - shareVerifyQueueErrorTime[index] < 1*60*1000 && shareVerifyQueueErrorCount[index] > 10) return;
            const qlength = queue_obj.length() + queue_obj.running();
            if (min_queue_size === null || qlength < min_queue_size) {
                best_index     = index;
                min_queue_size = qlength;
            }
        });
        if (best_index === null) shareVerifyQueueErrorTime.forEach(function(last_error_time, index) {
            const noerr_time = time_now - last_error_time;
            if (max_noerr_time === null || noerr_time > max_noerr_time) {
                best_index     = index;
                max_noerr_time = noerr_time;
            }
        });
        return shareVerifyQueue[best_index].unshift({
            jsonInput:     jsonInput,
            cb:            cb,
            time:          time_now,
            miner_address: miner_address
        });
    }

    this.c29 = function(header, ring, port) {
        switch (port) {
            case 19281: return multiHashing.c29v(header, ring);	// MoneroV
            case 19950: return multiHashing.c29s(header, ring);	// Swap
            case 25182: return multiHashing.c29b(header, ring);	// TUBE
            case 33124: return multiHashing.c29s(header, ring);	// XtendCash
            default:
		console.error("Unknown " + port + " port for Cuckaroo PoW type");
		return multiHashing.c29s(header, ring);
        }
    }

    this.c29_cycle_hash = function(ring, blob_type_num) {
        switch (blob_type_num) {
            case 10: return multiHashing.c29b_cycle_hash(ring);
            case 12: return multiHashing.c29i_cycle_hash(ring);
            default: return multiHashing.c29_cycle_hash(ring);
        }
    }

    this.blobTypeStr = function(port, version) {
        switch (port) {
            case 2086:  return "forknote1";       // BLOC
	    case 8545:  return "eth";             // ETH
	    case 8645:  return "eth";             // ETC
	    case 8766:  return "raven";           // RVN
	    case 9053:  return "erg";             // ERG
            case 9231:  return "cryptonote_loki"; // XEQ
	    case 9998:  return "raptoreum";       // RTM
            //case 11181: return "aeon";            // Aeon
            case 11898: return "forknote2";       // TRTL
            case 13007: return "forknote2";       // Iridium
            case 12211: return "cryptonote_ryo";  // RYO
            case 17750: return "cryptonote_xhv";  // XHV
            case 19281: return "cuckaroo";        // MoneroV
            case 19950: return "cuckaroo";        // Swap
            case 20206: return "cryptonote_dero"; // Dero
            case 22023: return "cryptonote_loki"; // LOKI
            case 25182: return "cryptonote_tube"; // TUBE
            case 33124: return "cryptonote_xtnc"; // XtendCash
            case 38081: return "cryptonote3";     // MSR
            default:    return "cryptonote";
        }
    }

    this.algoShortTypeStr = function(port, version) {
        if (port in port2algo) return port2algo[port];
        console.error("Unknown " + port + " port for PoW type on " + version + " version");
	return "rx/0";
    }

    this.isMinerSupportAlgo = function(algo, algos) {
        if (algo in algos) return true;
        if (algo === "cn-heavy/0" && "cn-heavy" in algos) return true;
        return false;
    }

    this.get_miner_agent_warning_notification = function(agent) {
        let m;
        if (m = reXMRig.exec(agent)) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            if (majorv + minorv < 30200) {
                return "Please update your XMRig miner (" + agent + ") to v3.2.0+ to support new rx/0 Monero algo";
            }
            if (majorv + minorv >= 40000 && majorv + minorv < 40200) {
                return "Please update your XMRig miner (" + agent + ") to v4.2.0+ to support new rx/0 Monero algo";
            }
        } else if (m = reXMRSTAKRX.exec(agent)) {
            return false;
        } else if (m = reXMRSTAK.exec(agent)) {
            return "Please update your xmr-stak miner (" + agent + ") to xmr-stak-rx miner to support new rx/0 Monero algo";
        } else if (m = reXNP.exec(agent)) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            const minorv2 = parseInt(m[3]);
            const version = majorv + minorv + minorv2;
            if (version < 1400) {
                 return "Please update your xmr-node-proxy (" + agent + ") to version v0.14.0+ by doing 'cd xmr-node-proxy && ./update.sh' (or check https://github.com/MoneroOcean/xmr-node-proxy repo) to support new rx/0 Monero algo";
            }
        } else if (m = reSRBMULTI.exec(agent)) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            const minorv2 = parseInt(m[3]);
            if (majorv + minorv + minorv2 < 105) {
                 return "Please update your SRBminer-MULTI (" + agent + ") to version v0.1.5+ to support new rx/0 Monero algo";
            }
        }
        return false;
    };

    this.is_miner_agent_no_haven_support = function(agent) {
        let m;
        if (m = reXMRig.exec(agent)) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            if (majorv + minorv < 60300) {
                return true;
            }
        }
        return false;
    };

    this.get_miner_agent_not_supported_algo = function(agent) {
        let m;
        if (m = reXMRSTAKRX.exec(agent)) {
            return "rx/0";
        } else if (m = reXMRSTAK.exec(agent)) {
            return "cn/r";
        }
        return false;
    };

    this.fixDaemonIssue = function(height, top_height, port) {
        global.support.sendEmail(global.config.general.adminEmail,
            "Pool server " + global.config.hostname + " has stuck block template",
            "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " with current block height " +
            height + " is stuck compared to top height (" + top_height + ") amongst other leaf nodes for " +
            port + " port\nAttempting to fix..."
        );
        if (fs.existsSync(fix_daemon_sh)) {
            child_process.exec(fix_daemon_sh + " " + port, function callback(error, stdout, stderr) {
                console.log("> " + fix_daemon_sh + " " + port);
                console.log(stdout);
                console.error(stderr);
                if (error) console.error(fix_daemon_sh + " script returned error exit code: " + error.code);
            });
        } else {
            console.error("No " + fix_daemon_sh + " script was found to fix stuff");
        }
    }
};



module.exports = Coin;
