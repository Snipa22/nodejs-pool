"use strict";
const request = require('request');
const async = require('async');
const Threads = require('threads_a_gogo');
const pool = Threads.createPool(32);

function Database() {

    this.remoteSender = function(task_body){
        request.post({url: global.config.general.shareHost, body: task_body, forever: true}, function (error, response, body) {
            if (error || response.statusCode !== 200) {
                global.database.sendQueue.push({body: task_body}, function () {
                });
            }
        });
    };

    pool.all.eval(this.remoteSender);

    this.sendQueue = async.queue(function (task, callback) {
        pool.any.eval('this.remoteSender(' + task.body + ')', function(){
            callback();
        });
    }, 32);

    this.storeShare = function (blockId, shareData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.SHARE,
            key: global.config.api.authKey,
            msg: shareData,
            exInt: blockId
        });
        this.sendQueue.push({body: wsData}, function () {
        });
    };

    this.storeBlock = function (blockId, blockData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.BLOCK,
            key: global.config.api.authKey,
            msg: blockData,
            exInt: blockId
        });
        this.sendQueue.push({body: wsData}, function () {
        });
    };

    this.storeInvalidShare = function (minerData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.INVALIDSHARE,
            key: global.config.api.authKey,
            msg: minerData,
            exInt: 1
        });
        this.sendQueue.push({body: wsData}, function () {
        });
    };

    this.initEnv = function(){
        this.data = null;
    };
}

module.exports = Database;