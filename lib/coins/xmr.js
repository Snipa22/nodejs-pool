"use strict";
const bignum = require('bignum');
const cnUtil = require('cryptonote-util');
const multiHashing = require('multi-hashing');
const crypto = require('crypto');

function Coin(data){
    this.data = data;
    let instanceId = crypto.randomBytes(4);
    this.coinDevAddress = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";  // Developer Address
    this.poolDevAddress = "44Ldv5GQQhP7K7t3ZBdZjkPA7Kg7dhHwk3ZM3RJqxxrecENSFx27Vq14NAMAd2HBvwEPUVVvydPRLcC69JCZDHLT2X5a4gr";  // Snipa Address

    this.blockedAddresses = [
        this.coinDevAddress,
        this.poolDevAddress,
        "43SLUTpyTgXCNXsL43uD8FWZ5wLAdX7Ak67BgGp7dxnGhLmrffDTXoeGm2GBRm8JjigN9PTg2gnShQn5gkgE1JGWJr4gsEU", // Wolf0's address
        "42QWoLF7pdwMcTXDviJvNkWEHJ4TXnMBh2Cx6HNkVAW57E48Zfw6wLwDUYFDYJAqY7PLJUTz9cHWB5C4wUA7UJPu5wPf4sZ", // Wolf0's address
        "46gq64YYgCk88LxAadXbKLeQtCJtsLSD63NiEc3XHLz8NyPAyobACP161JbgyH2SgTau3aPUsFAYyK2RX4dHQoaN1ats6iT" // Claymore's Fee Address.
        "47mr7jYTroxQMwdKoPQuJoc9Vs9S9qCUAL6Ek4qyNFWJdqgBZRn4RYY2QjQfqEMJZVWPscupSgaqmUn1dpdUTC4fQsu3yjN" // Claymore's _other_ fee address.
    ];

    this.exchangeAddresses = [
        "46yzCCD3Mza9tRj7aqPSaxVbbePtuAeKzf8Ky2eRtcXGcEgCg1iTBio6N4sPmznfgGEUGDoBz5CLxZ2XPTyZu1yoCAG7zt6", // Shapeshift.io
        "463tWEBn5XZJSxLU6uLQnQ2iY9xuNcDbjLSjkn3XAXHCbLrTTErJrBWYgHJQyrCwkNgYvyV3z8zctJLPCZy24jvb3NiTcTJ", // Bittrex
        "44TVPcCSHebEQp4LnapPkhb2pondb2Ed7GJJLc6TkKwtSyumUnQ6QzkCCkojZycH2MRfLcujCM7QR1gdnRULRraV4UpB5n4", // Xmr.to
        "47sghzufGhJJDQEbScMCwVBimTuq6L5JiRixD8VeGbpjCTA12noXmi4ZyBZLc99e66NtnKff34fHsGRoyZk3ES1s1V4QVcB" // Poloniex
    ]; // These are addresses that MUST have a paymentID to perform logins with.

    this.prefix = 18;
    this.intPrefix = 19;

    if (global.config.general.testnet === true){
        this.prefix = 53;
        this.intPrefix = 54;
    }

    this.niceHashDiff = 100000;

    this.getBlockHeaderByID = function(blockId, callback){
        global.support.rpcDaemon('getblockheaderbyheight', {"height": blockId}, function (body) {
            if (body.hasOwnProperty('result')){
                return callback(body.result.block_header);
            } else {
                console.error(JSON.stringify(body));
            }
        });
    };

    this.getBlockHeaderByHash = function(blockHash, callback){
        global.support.rpcDaemon('getblockheaderbyhash', {"hash": blockHash}, function (body) {
            if (typeof(body) !== 'undefined' && body.hasOwnProperty('result')){
                return callback(body.result.block_header);
            } else {
                console.error(JSON.stringify(body));
                return callback(false);
            }
        });
    };

    this.getLastBlockHeader = function(callback){
        global.support.rpcDaemon('getlastblockheader', [], function (body) {
            if (typeof(body) !== 'undefined' && body.hasOwnProperty('result')){
                return callback(body.result.block_header);
            } else {
                console.error(JSON.stringify(body));
            }
        });
    };

    this.getBlockTemplate = function(walletAddress, callback){
        global.support.rpcDaemon('getblocktemplate', {
            reserve_size: 8,
            wallet_address: walletAddress
        }, function(body){
            return callback(body);
        });
    };

    this.baseDiff = function(){
        return bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);
    };

    this.validateAddress = function(address){
        // This function should be able to be called from the async library, as we need to BLOCK ever so slightly to verify the address.
        address = new Buffer(address);
        if (cnUtil.address_decode(address) === this.prefix){
            return true;
        }
        return cnUtil.address_decode_integrated(address) === this.intPrefix;
    };

    this.convertBlob = function(blobBuffer){
        return cnUtil.convert_blob(blobBuffer);
    };

    this.constructNewBlob = function(blockTemplate, NonceBuffer){
        return cnUtil.construct_block_blob(blockTemplate, NonceBuffer);
    };

    this.getBlockID = function(blockBuffer){
        return cnUtil.get_block_id(blockBuffer);
    };

    this.BlockTemplate = function(template) {
        this.blob = template.blocktemplate_blob;
        this.difficulty = template.difficulty;
        this.height = template.height;
        this.reserveOffset = template.reserved_offset;
        this.buffer = new Buffer(this.blob, 'hex');
        instanceId.copy(this.buffer, this.reserveOffset + 4, 0, 3);
        this.previous_hash = new Buffer(32);
        this.buffer.copy(this.previous_hash, 0, 7, 39);
        this.extraNonce = 0;
        this.nextBlob = function () {
            this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
            return global.coinFuncs.convertBlob(this.buffer).toString('hex');
        };
    };

    this.cryptoNight = multiHashing['cryptonight'];

}

module.exports = Coin;
