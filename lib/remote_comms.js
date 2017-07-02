"use strict";
const request = require('request');
const async = require('async');

function Database() {

    this.sendQueue = async.queue(function (task, callback) {
        async.doUntil(
            function (intCallback) {
                request.post({url: global.config.general.shareHost, body: task.body, forever: true}, function (error, response, body) {
                    if (!error) {
                        return intCallback(null, response.statusCode);
                    }
                    return intCallback(null, 0);
                });
            },
            function (data) {
                return data === 200;
            },
            function () {
                callback();
            });
    }, 128);

    this.storeShare = function (blockId, shareData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.SHARE,
            key: global.config.api.authKey,
            msg: shareData,
            exInt: blockId
        });
        process.send({type: 'sendRemote', body: wsData.toString('hex')});
    };

    this.storeBlock = function (blockId, blockData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.BLOCK,
            key: global.config.api.authKey,
            msg: blockData,
            exInt: blockId
        });
        process.send({type: 'sendRemote', body: wsData.toString('hex')});
    };

    this.storeInvalidShare = function (minerData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.INVALIDSHARE,
            key: global.config.api.authKey,
            msg: minerData,
            exInt: 1
        });
        process.send({type: 'sendRemote', body: wsData.toString('hex')});
    };

    this.initEnv = function(){
        this.data = null;
    };
}

module.exports = Database;