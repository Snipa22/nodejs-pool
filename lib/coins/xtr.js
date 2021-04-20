'use strict';
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
const { compareGte, aux } = require('../common');

const reXMRig = /XMRig(?:-[a-zA-Z]+)?\/(\d+)\.(\d+)\./; // 2.8.0
const reXMRSTAKRX = /\w+-stak-rx\/(\d+)\.(\d+)\.(\d+)/; // 1.0.1
const reXMRSTAK = /\w+-stak(?:-[a-zA-Z]+)?\/(\d+)\.(\d+)\.(\d+)/; // 2.5.0
const reXNP = /xmr-node-proxy\/(\d+)\.(\d+)\.(\d+)/; // 0.3.2
const reSRBMULTI = /SRBMiner-MULTI\/(\d+)\.(\d+)\.(\d+)/; // 0.1.5

const pool_nonce_size = 16 + 1; // 1 extra byte for old XMR and new TRTL daemon bugs
// const port2coin = {
//     7878: '',
// };
// const port2blob_num = {
//     7878: 0,
// };
//
// const port2algo = {
//     7878: 'rx/0',
// };
//
// const coin2port = (() => {
//     let coin2port = {};
//     for (let port in port2coin) coin2port[port2coin[port]] = parseInt(port);
//     return coin2port;
// })();

const mm_nonce_size = cnUtil.get_merged_mining_nonce_size();
// const mm_port_set = {};

const fix_daemon_sh = './fix_daemon.sh';

const extra_nonce_template_hex =
    '02' + (pool_nonce_size + 0x100).toString(16).substr(-2) + '00'.repeat(pool_nonce_size);
// const extra_nonce_mm_template_hex =
//     '02' +
//     (mm_nonce_size + pool_nonce_size + 0x100).toString(16).substr(-2) +
//     '00'.repeat(mm_nonce_size + pool_nonce_size);

// function get_coins(port2coin) {
//     let coins = [];
//     for (let port in port2coin) if (port2coin[port] != '') coins.push(port2coin[port]);
//     return coins;
// }

// const ports = Object.keys(port2coin);
// const coins = get_coins(port2coin);

// function get_mm_child_port_set(mm_port_set) {
//     let mm_child_port_set = {};
//     for (let port in mm_port_set) {
//         const child_port = mm_port_set[port];
//         if (!(child_port in mm_child_port_set)) mm_child_port_set[child_port] = {};
//         mm_child_port_set[child_port][port] = 1;
//     }
//     return mm_child_port_set;
// }

// function get_algos() {
//     let algos = {};
//     for (let port in port2algo) algos[port2algo[port]] = 1;
//     return algos;
// }

const all_algos = ['rx/0'];
// const mm_child_port_set = get_mm_child_port_set(mm_port_set);

let shareVerifyQueue = async.queue(function (task, queueCB) {
    const cb = task.cb;
    if (Date.now() - task.time > 5 * 60 * 1000) {
        cb(null);
        return queueCB();
    }

    const jsonInput = task.jsonInput;

    let socket = new net.Socket();
    let is_cb = false;
    let return_cb = function (result) {
        if (is_cb) return;
        is_cb = true;
        cb(result);
        return queueCB();
    };
    let timer = setTimeout(function () {
        socket.destroy();
        return return_cb(false);
    }, 60 * 1000);
    socket.connect(2222, global.config.verify_shares_host, function () {
        socket.write(JSON.stringify(jsonInput) + '\n');
    });

    let buff = '';
    socket.on('data', function (buff1) {
        buff += buff1;
    });

    socket.on('end', function () {
        clearTimeout(timer);
        timer = null;
        try {
            const jsonOutput = JSON.parse(buff.toString());
            if (!('result' in jsonOutput)) return return_cb(false);
            return return_cb(jsonOutput.result);
        } catch (e) {
            return return_cb(false);
        }
    });

    socket.on('error', function () {
        socket.destroy();
        return return_cb(false);
    });
}, 32);

setInterval(
    function (queue_obj) {
        if (queue_obj.length() > 1000) {
            queue_obj.remove(function (task) {
                if (Date.now() - task.time > 5 * 60 * 1000) {
                    task.cb(null);
                    return true;
                }
                return false;
            });
            console.log(
                global.database.thread_id +
                    'Share verify queue state: ' +
                    queue_obj.length() +
                    ' items in the queue ' +
                    queue_obj.running() +
                    ' items being processed',
            );
        }
    },
    30 * 1000,
    shareVerifyQueue,
);

function Coin(data) {
    this.bestExchange = global.config.payout.bestExchange;
    this.data = data;
    let instanceId = Buffer.alloc(4);
    instanceId.writeUInt32LE(((global.config.pool_id % (1 << 10) << 22) + (process.pid % (1 << 22))) >>> 0);
    console.log('Generated instanceId: ' + instanceId.toString('hex'));
    // If this address is used, extra debug info is logged for the miner
    this.testDevAddress =
        'c6037038cce673cf1c1e26e7b7609ffbbba297eae4caf3ce7123a949c7af0162:581EfC8NL2yLZyavVrY2dGZNsqBzzcU5yE8iLrFwPLkQHxUckaWy8vjeLntrynGoBwLeKTBdgJ2rR66ZiqKogkhpS8DAMR3';
    this.coinDevAddress =
        '56a5d84aa176ea4ff63ca6fa4302072826f88a0eab65231077a37cef476ab008:55SRBTZYdjQATpJJjxXtY5Kb1uDoj8eDfQrp3LWopbxmKrr3uM4QsbqMyXyZRpHNqkKEifJ7Wr24V9kDgfZtjFeoDjZzk6D';
    this.poolDevAddress =
        '56a5d84aa176ea4ff63ca6fa4302072826f88a0eab65231077a37cef476ab008:55SRBTZYdjQATpJJjxXtY5Kb1uDoj8eDfQrp3LWopbxmKrr3uM4QsbqMyXyZRpHNqkKEifJ7Wr24V9kDgfZtjFeoDjZzk6D';

    this.blockedAddresses = [this.coinDevAddress, this.poolDevAddress];

    this.exchangeAddresses = []; // These are addresses that MUST have a paymentID to perform logins with.

    this.supportsAutoExchange = true;

    this.niceHashDiff = 400000;

    const getPortBlockHeaderByID = function (port, blockId, callback) {
        global.support.rpcPortDaemon(port, 'getblockheaderbyheight', { height: blockId }, function (err, body) {
            if (body && body.hasOwnProperty('result')) {
                return callback(null, body.result.block_header);
            } else {
                console.error(JSON.stringify(body));
                return callback(true, body);
            }
        });
    };

    this.getBlockHeaderByID = function (blockId, callback) {
        return getPortBlockHeaderByID(global.config.daemon.port, blockId, callback);
    };

    const getPortBlockHeaderByHash = function (port, blockHash, callback) {
        global.support.rpcPortDaemon(port, 'get_block_header_by_hash', { hash: blockHash }, callback);
    };

    this.getBlockHeaderByHash = function (blockHash, callback) {
        return getPortBlockHeaderByHash(global.config.daemon.port, blockHash, (err, body) => {
            if (err) {
                callback(err, null);
                return;
            }

            if (body.error) {
                console.error(body.error);
                callback(body.error, null);
                return;
            }

            callback(null, body.result.block_header);
        });
    };

    const getPortLastBlockHeader = function (port, callback) {
        global.support.rpcPortDaemon(port, 'getlastblockheader', [], function (err, body) {
            if (err) {
                callback(err, null);
                return;
            }

            if (body.error) {
                callback(body.error, null);
                return;
            }

            return callback(null, body.result);
        });
    };

    this.getLastBlockHeader = function (callback) {
        return getPortLastBlockHeader(global.config.daemon.port, callback);
    };

    const getPortBlockTemplate = function (port, callback) {
        const reserve_size = pool_nonce_size;
        const { monero: wallet_address } = aux.tryParseMergeMiningAddress(global.config.pool.address);

        global.support.rpcPortDaemon(
            port,
            'getblocktemplate',
            {
                reserve_size: reserve_size,
                wallet_address,
            },
            function (err, body) {
                if (err) {
                    callback(err, null);
                    return;
                }

                if (body.error) {
                    callback(body.error, null);
                    return;
                }

                return callback(null, body.result);
            },
        );
    };

    this.getBlockTemplate = function (callback) {
        return getPortBlockTemplate(global.config.daemon.port, callback);
    };

    this.baseDiff = function () {
        return bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);
    };
    this.baseRavenDiff = function () {
        return parseInt('0x00000000ff000000000000000000000000000000000000000000000000000000');
    };

    this.validatePlainAddress = function (address) {
        // This function should be able to be called from the async library, as we need to BLOCK ever so slightly to verify the address.
        let code = cnUtil.address_decode(Buffer.from(address, 'uft8'));
        return code === this.prefix || code === this.subPrefix;
    };

    this.validateAddress = function (address) {
        try {
            aux.tryParseMergeMiningAddress(address);
            return true;
        } catch (err) {
            console.error(err);
            return false;
        }
    };

    this.portBlobType = function (port, version) {
        // Always blob type 0
        return 0;
    };

    this.blobTypeGrin = function (blob_type_num) {
        switch (blob_type_num) {
            case 8:
            case 9:
            case 10:
            case 12:
                return true;
            default:
                return false;
        }
    };

    this.c29ProofSize = function (blob_type_num) {
        switch (blob_type_num) {
            case 10:
                return 40;
            case 12:
                return 48;
            default:
                return 32;
        }
    };

    this.nonceSize = function (blob_type_num) {
        switch (blob_type_num) {
            case 7:
            case 101:
                return 8;
            default:
                return 4;
        }
    };

    this.blobTypeDero = function (blob_type_num) {
        return blob_type_num == 100;
    };

    this.blobTypeRaven = function (blob_type_num) {
        return blob_type_num == 101;
    };

    this.targetRavenDiff = function (diff) {
        return cnUtil.targetRavenDiff(diff);
    };

    this.convertBlob = function (blobBuffer, port) {
        try {
            const blob_type_num = this.portBlobType(port, blobBuffer[0]);
            return cnUtil.convert_blob(blobBuffer, blob_type_num);
        } catch (e) {
            const err_str =
                "Can't do port " +
                port +
                ' convert_blob ' +
                blobBuffer.toString('hex') +
                ' with blob type ' +
                blob_type_num +
                ': ' +
                e;
            console.error(err_str);
            global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't convert_blob", err_str);
            return null;
        }
    };

    this.constructNewBlob = function (blockTemplate, params, port) {
        const blob_type_num = this.portBlobType(port, blockTemplate[0]);
        return cnUtil.construct_block_blob(blockTemplate, new Buffer(params.nonce, 'hex'), blob_type_num);
    };

    this.constructMMParentBlockBlob = function (parentTemplateBuffer, port, childTemplateBuffer) {
        //console.log("MERGED MINING: constructMMParentBlockBlob");
        return cnUtil.construct_mm_parent_block_blob(
            parentTemplateBuffer,
            this.portBlobType(port, parentTemplateBuffer[0]),
            childTemplateBuffer,
        );
    };

    this.constructMMChildBlockBlob = function (shareBuffer, port, childTemplateBuffer) {
        console.log('MERGED MINING: constructMMChildBlockBlob');
        return cnUtil.construct_mm_child_block_blob(
            shareBuffer,
            this.portBlobType(port, shareBuffer[0]),
            childTemplateBuffer,
        );
    };

    this.getBlockID = function (blockBuffer, port) {
        const blob_type_num = this.portBlobType(port, blockBuffer[0]);
        return cnUtil.get_block_id(blockBuffer, blob_type_num);
    };

    this.BlockTemplate = function (template) {
        debug(`Block template: ${JSON.stringify(template)}`);
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

        // Set these params equal to values we get from upstream.
        this.blocktemplate_blob = template.blocktemplate_blob || template.blob;

        // The difficulty that either the base or aux chains will accept i.e min(base diff, aux diff)
        this.difficulty = template.difficulty;

        this.auxDifficulty = this.baseCoinDifficulty = template.difficulty;
        this.altHeight = null;
        let auxData = aux.getData(template);
        let auxChains = null;
        if (auxData) {
            debug(`Received aux data in block template: ${JSON.stringify(template)}`);
            auxChains = auxData.chains || [];
            this.baseCoinDifficulty = auxData.base_difficulty;
            const chain = aux.findChainData(auxData, 'xtr');
            if (chain) {
                this.auxDifficulty = chain.difficulty;
                this.altHeight = chain.height;
            }
        }
        this.height = template.height;
        this.bits = template.bits;
        this.seed_hash = template.seed_hash;
        this.coin = template.coin;
        this.port = template.port;

        const blob = this.blocktemplate_blob;

        this.idHash = crypto.createHash('md5').update(blob).digest('hex');

        // Set this.buffer to the binary decoded version of the BT blob
        this.buffer = new Buffer(blob, 'hex');

        const template_hex = extra_nonce_template_hex;
        const found_reserved_offset_template = blob.indexOf(template_hex);

        if (found_reserved_offset_template !== -1) {
            const found_reserved_offset = (found_reserved_offset_template >> 1) + 2;
            if (template.reserved_offset) {
                // here we are OK with +1 difference because we put extra byte into pool_nonce_size
                if (
                    found_reserved_offset != template.reserved_offset &&
                    found_reserved_offset + 1 != template.reserved_offset
                ) {
                    console.error(
                        'INTERNAL ERROR: Found reserved offset ' +
                            found_reserved_offset +
                            ' do not match ' +
                            template.reserved_offset +
                            ' reported by daemon in ' +
                            this.port +
                            ' block ' +
                            ': ' +
                            blob,
                    );
                }
                this.reserved_offset = template.reserved_offset;
            } else if (template.reservedOffset) {
                // here we are OK with +1 difference because we put extra byte into pool_nonce_size
                if (
                    found_reserved_offset != template.reservedOffset &&
                    found_reserved_offset + 1 != template.reservedOffset
                ) {
                    console.error(
                        'INTERNAL ERROR: Found reserved offset ' +
                            found_reserved_offset +
                            ' do not match ' +
                            template.reservedOffset +
                            ' reported by daemon in ' +
                            this.port +
                            ' block ' +
                            ': ' +
                            blob,
                    );
                }
                this.reserved_offset = template.reservedOffset;
            } else {
                this.reserved_offset = found_reserved_offset;
            }
        } else {
            //console.error("INTERNAL ERROR: Can not find reserved offset template '" + template_hex + "' in " + this.port + " block " + ": " + blob);
            this.reserved_offset = template.reserved_offset ? template.reserved_offset : template.reservedOffset;
        }

        if (!this.reserved_offset) this.reserved_offset = 0; // to avoid hard crash

        if (!('prev_hash' in template)) {
            // Get prev_hash from blob
            let prev_hash = new Buffer(32);
            const prev_hash_start = global.coinFuncs.blobTypeRaven(port2blob_num[this.port]) ? 4 : 7;
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

        this.nextBlob = function () {
            // Write a 32 bit integer, big-endian style to the 0 byte of the reserve offset.
            this.buffer.writeUInt32BE(++this.extraNonce, this.reserved_offset);
            // Convert the buffer into something hashable.
            return global.coinFuncs.convertBlob(this.buffer, this.port);
        };
        // Make it so you can get the raw block buffer out.
        this.nextBlobWithChildNonceHex = function () {
            // Write a 32 bit integer, big-endian style to the 0 byte of the reserve offset.
            this.buffer.writeUInt32BE(++this.extraNonce, this.reserved_offset);
            // Don't convert the buffer to something hashable.  You bad.
            return this.buffer.toString('hex');
        };

        this.isDifficultyAchieved = (diff) => compareGte(diff, this.difficulty);
        this.isBaseDifficultyAchieved = (diff) => compareGte(diff, this.baseCoinDifficulty || this.difficulty);
        this.isAuxChainDifficultyAchieved = (coin, achievedDiff) => {
            let data = this.getAuxChainData(coin) || {};
            if (!data.difficulty) {
                throw new Error(`No difficulty information for aux chain '${coin}'`);
            }
            return compareGte(data.difficulty, achievedDiff);
        };

        this.getAuxChainData = (coin) => {
            if (!auxChains) {
                return null;
            }
            return auxChains.find((ch) => ch.id === coin);
        };
    };

    this.compareDifficulty = compareGte;

    // this.getPORTS = function () {
    //     return ports;
    // };
    this.getCOINS = function () {
        // '' means monero
        return [''];
    };
    // this.PORT2COIN = function (port) {
    //     return port2coin[port];
    // };
    // this.COIN2PORT = function (coin) {
    //     return coin2port[coin];
    // };
    // this.getMM_PORTS = function () {
    //     return mm_port_set;
    // };
    // this.getMM_CHILD_PORTS = function () {
    //     return mm_child_port_set;
    // };

    this.getDefaultAlgos = function () {
        return ['rx/0'];
    };

    this.getDefaultAlgosPerf = function () {
        return { 'rx/0': 1 };
    };

    this.getPrevAlgosPerf = function () {
        return { 'cn/r': 1, 'cn/half': 1.9, 'cn/rwz': 1.3, 'cn/zls': 1.3, 'cn/double': 0.5 };
    };

    this.convertAlgosToCoinPerf = function (algos_perf) {
        let coin_perf = {};

        if ('rx/0' in algos_perf) coin_perf[''] = algos_perf['rx/0'];

        if ('cn/r' in algos_perf) coin_perf['SUMO'] = coin_perf['LTHN'] = algos_perf['cn/r'];

        if ('cn/half' in algos_perf) coin_perf['MSR'] = algos_perf['cn/half'];
        else if ('cn/fast2' in algos_perf) coin_perf['MSR'] = algos_perf['cn/fast2'];

        if ('panthera' in algos_perf) coin_perf['XLA'] = algos_perf['panthera'];

        if ('cn/gpu' in algos_perf) coin_perf['RYO'] = coin_perf['CCX'] = coin_perf['XEQ'] = algos_perf['cn/gpu'];

        if ('rx/wow' in algos_perf) coin_perf['WOW'] = algos_perf['rx/wow'];

        if ('kawpow' in algos_perf) coin_perf['RVN'] = algos_perf['kawpow'];

        if ('cn/rwz' in algos_perf) coin_perf['GRFT'] = algos_perf['cn/rwz'];

        if ('cn-heavy/xhv' in algos_perf) coin_perf['XHV'] = algos_perf['cn-heavy/xhv'];

        if ('k12' in algos_perf) coin_perf['AEON'] = algos_perf['k12'];

        if ('cn-pico' in algos_perf) coin_perf['IRD'] = algos_perf['cn-pico'];
        else if ('cn-pico/trtl' in algos_perf) coin_perf['IRD'] = algos_perf['cn-pico/trtl'];

        if ('rx/arq' in algos_perf) coin_perf['ARQ'] = algos_perf['rx/arq'];

        if ('c29s' in algos_perf) coin_perf['XTNC'] = coin_perf['XWP'] = algos_perf['c29s'];
        if ('c29v' in algos_perf) coin_perf['XMV'] = algos_perf['c29v'];
        if ('c29b' in algos_perf) coin_perf['TUBE'] = algos_perf['c29b'];
        if ('c29i' in algos_perf) coin_perf['XTA'] = algos_perf['c29i'];

        if ('astrobwt' in algos_perf) coin_perf['DERO'] = algos_perf['astrobwt'];

        if ('cn/0' in algos_perf) coin_perf['XMC'] = algos_perf['cn/0'];

        if ('argon2/chukwav2' in algos_perf) coin_perf['TRTL'] = algos_perf['argon2/chukwav2'];
        else if ('chukwav2' in algos_perf) coin_perf['TRTL'] = algos_perf['chukwav2'];

        return coin_perf;
    };

    // returns true if algo set reported by miner is for main algo
    this.algoMainCheck = function (algos) {
        if ('rx/0' in algos) return true;
        return false;
    };
    // returns true if algo set reported by miner is one of previous main algos
    this.algoPrevMainCheck = function (algos) {
        if ('cn/r' in algos) return true;
        return false;
    };
    // returns true if algo set reported by miner is OK or error string otherwise
    this.algoCheck = function (algos) {
        if (this.algoMainCheck(algos)) return true;
        for (let algo in all_algos) if (algo in algos) return true;
        return 'algo array must include at least one supported pool algo: [' + Object.keys(algos).join(', ') + ']';
    };

    this.slowHashBuff = function (convertedBlob, blockTemplate) {
        return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, 'hex'), 0); // XMR
    };

    this.slowHash = function (convertedBlob, blockTemplate, nonce, mixhash) {
        return this.slowHashBuff(convertedBlob, blockTemplate, nonce, mixhash).toString('hex');
    };

    this.slowHashAsync = function (convertedBlob, blockTemplate, cb) {
        if (!global.config.verify_shares_host) return cb(this.slowHash(convertedBlob, blockTemplate));
        const jsonInput = {
            algo: port2algo[blockTemplate.port],
            blob: convertedBlob.toString('hex'),
            seed_hash: blockTemplate.seed_hash,
        };

        return shareVerifyQueue.unshift({ jsonInput: jsonInput, cb: cb, time: Date.now() });
    };

    this.c29_cycle_hash = function (ring, blob_type_num) {
        switch (blob_type_num) {
            case 10:
                return multiHashing.c29b_cycle_hash(ring);
            case 12:
                return multiHashing.c29i_cycle_hash(ring);
            default:
                return multiHashing.c29_cycle_hash(ring);
        }
    };

    this.blobTypeStr = function (port, version) {
        switch (port) {
            case 8766:
                return 'raven'; // RVN
            case 9231:
                return 'cryptonote_loki'; // XEQ
            case 11181:
                return 'aeon'; // Aeon
            case 11898:
                return 'forknote2'; // TRTL
            case 13007:
                return 'forknote2'; // Iridium
            case 12211:
                return 'cryptonote_ryo'; // RYO
            case 13102:
                return 'cryptonote_xta'; // Italocoin
            case 17750:
                return 'cryptonote_xhv'; // XHV
            case 19281:
                return 'cuckaroo'; // MoneroV
            case 19950:
                return 'cuckaroo'; // Swap
            case 20206:
                return 'cryptonote_dero'; // Dero
            case 22023:
                return 'cryptonote_loki'; // LOKI
            case 25182:
                return 'cryptonote_tube'; // TUBE
            case 33124:
                return 'cryptonote_xtnc'; // XtendCash
            case 38081:
                return 'cryptonote3'; // MSR
            default:
                return 'cryptonote';
        }
    };

    this.algoShortTypeStr = function (port, version) {
        return 'rx/0';
    };

    this.isMinerSupportAlgo = function (algo, algos) {
        if (algo in algos) return true;
        if (algo === 'cn-heavy/0' && 'cn-heavy' in algos) return true;
        return false;
    };

    this.get_miner_agent_warning_notification = function (agent) {
        let m;
        if ((m = reXMRig.exec(agent))) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            if (majorv + minorv < 30200) {
                return 'Please update your XMRig miner (' + agent + ') to v3.2.0+ to support new rx/0 Monero algo';
            }
            if (majorv + minorv >= 40000 && majorv + minorv < 40200) {
                return 'Please update your XMRig miner (' + agent + ') to v4.2.0+ to support new rx/0 Monero algo';
            }
        } else if ((m = reXMRSTAKRX.exec(agent))) {
            return false;
        } else if ((m = reXMRSTAK.exec(agent))) {
            return (
                'Please update your xmr-stak miner (' + agent + ') to xmr-stak-rx miner to support new rx/0 Monero algo'
            );
        } else if ((m = reXNP.exec(agent))) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            const minorv2 = parseInt(m[3]);
            const version = majorv + minorv + minorv2;
            if (version < 1400) {
                return (
                    'Please update your xmr-node-proxy (' +
                    agent +
                    ") to version v0.14.0+ by doing 'cd xmr-node-proxy && ./update.sh' (or check https://github.com/MoneroOcean/xmr-node-proxy repo) to support new rx/0 Monero algo"
                );
            }
        } else if ((m = reSRBMULTI.exec(agent))) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            const minorv2 = parseInt(m[3]);
            if (majorv + minorv + minorv2 < 105) {
                return (
                    'Please update your SRBminer-MULTI (' +
                    agent +
                    ') to version v0.1.5+ to support new rx/0 Monero algo'
                );
            }
        }
        return false;
    };

    this.is_miner_agent_no_haven_support = function (agent) {
        let m;
        if ((m = reXMRig.exec(agent))) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            if (majorv + minorv < 60300) {
                return true;
            }
        }
        return false;
    };

    this.get_miner_agent_not_supported_algo = function (agent) {
        let m;
        if ((m = reXMRSTAKRX.exec(agent))) {
            return 'rx/0';
        } else if ((m = reXMRSTAK.exec(agent))) {
            return 'cn/r';
        }
        return false;
    };

    this.fixDaemonIssue = function (height, top_height, port) {
        global.support.sendEmail(
            global.config.general.adminEmail,
            'Pool server ' + global.config.hostname + ' has stuck block template',
            'The pool server: ' +
                global.config.hostname +
                ' with IP: ' +
                global.config.bind_ip +
                ' with current block height ' +
                height +
                ' is stuck compared to top height (' +
                top_height +
                ') amongst other leaf nodes for ' +
                port +
                ' port\nAttempting to fix...',
        );
        if (fs.existsSync(fix_daemon_sh)) {
            child_process.exec(fix_daemon_sh + ' ' + port, function (error, stdout, stderr) {
                console.log('> ' + fix_daemon_sh + ' ' + port);
                console.log(stdout);
                console.error(stderr);
                if (error) console.error(fix_daemon_sh + ' script returned error exit code: ' + error.code);
            });
        } else {
            console.error('No ' + fix_daemon_sh + ' script was found to fix stuff');
        }
    };
}

module.exports = Coin;
