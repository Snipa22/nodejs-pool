'use strict';

let range = require('range');
const argv = require('minimist')(process.argv.slice(2));

if (!argv.user && !argv.all) {
    console.error('Please specify user address to dump');
    process.exit(1);
}
const user = argv.user;
const dump_all = !!argv.all;

let paymentid;
if (argv.paymentid) paymentid = argv.paymentid;

let worker;
if (argv.worker) worker = argv.worker;

let depth = 10;
if (argv.depth) depth = argv.depth;

console.log('Dumping shares for ' + user + ' user');
if (paymentid) console.log('Dumping shares for ' + paymentid + ' paymentid');
if (worker) console.log('Dumping shares for ' + worker + ' worker');

require('../init_mini.js').init(function () {
    global.coinFuncs.getLastBlockHeader(function (err, body) {
        if (err !== null) {
            console.error('Invalid block header');
            process.exit(1);
        }
        let header = body.block_header;
        let lastBlock = header.height + 1;
        let txn = global.database.env.beginTxn({ readOnly: true });

        let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
        range.range(lastBlock, lastBlock - depth, -1).forEach(function (blockID) {
            for (let found = cursor.goToRange(parseInt(blockID)) === blockID; found; found = cursor.goToNextDup()) {
                cursor.getCurrentBinary(function (key, data) {
                    // jshint ignore:line
                    let shareData = global.protos.Share.decode(data);
                    if (
                        (dump_all || shareData.paymentAddress === user) &&
                        (!paymentid || shareData.paymentID === paymentid) &&
                        (!worker || shareData.identifier === worker)
                    ) {
                        console.log(JSON.stringify(shareData, null, 2));
                    }
                });
            }
        });
        cursor.close();
        txn.commit();
        process.exit(0);
    });
});
