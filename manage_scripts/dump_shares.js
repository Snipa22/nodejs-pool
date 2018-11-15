"use strict";

let range = require('range');
const argv = require('minimist')(process.argv.slice(2));

if (!argv.user) {
        console.error("Please specify user address to dump");
        process.exit(1);
}
const user = argv.user;

let paymentid;
if (argv.paymentid) paymentid = argv.paymentid;

let worker;
if (argv.worker) worker = argv.worker;

let depth = 10;
if (argv.depth) depth = argv.depth;

console.log("Dumping shares for " + user + " user");
if (paymentid) console.log("Dumping shares for " + paymentid + " paymentid");
if (worker)    console.log("Dumping shares for " + worker + " worker");

require("../init_mini.js").init(function() {

        global.coinFuncs.getLastBlockHeader(function (err, body) {
                if (err !== null) {
                        console.error("Invalid block header");
                        process.exit(1);
                }
                let lastBlock = body.height + 1;
                let txn = global.database.env.beginTxn({readOnly: true});

                let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
                range.range(lastBlock, lastBlock - depth, -1).forEach(function (blockID) {
                        for (let found = (cursor.goToRange(parseInt(blockID)) === blockID); found; found = cursor.goToNextDup()) {
                                cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                                        let shareData = global.protos.Share.decode(data);
                                        if (shareData.paymentAddress === user && (!paymentid || shareData.paymentID === paymentid) && (!worker || shareData.identifier === worker)) {
                                                var d = new Date(shareData.timestamp);
                                                console.log(d.toString() + ": " + JSON.stringify(shareData))
                                        }
                                });
                        }
                });
                cursor.close();
                txn.commit();
                process.exit(0);
        });
});
