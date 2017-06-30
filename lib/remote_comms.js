"use strict";
const request = require('request');
const async = require('async');
const Threads = require('threads_a_gogo');
const pool = Threads.createPool(32);

function Database() {

    let thread_id = "";

    this.remoteSender = function(task_body){
        request.post({url: global.config.general.shareHost, body: task_body, forever: true}, function (error, response, body) {
            if (error || response.statusCode !== 200) {
                global.database.sendQueue.push({body: task_body}, function () {
                });
            }
        });
    };

    this.sendQueue = async.queue(function (task, callback) {
        pool.any.eval('global.database.remoteSender(' + task.body + ')', function(){
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

    setInterval(function(queue_obj){
        console.log(global.database.thread_id + "Queue debug state: " + queue_obj.length() + " items in the queue " + queue_obj.running() + " items being processed");
        console.log(global.database.thread_id + "SendQueue thread state: " + pool.pendingJobs() + " items in the system " + (pool.totalThreads()-pool.idleThreads()) + " items being processed");
    }, 5000, this.sendQueue);


    this.initEnv = function(){
        this.data = null;
        pool.all.eval(global.database.remoteSender);
    };
}

module.exports = Database;