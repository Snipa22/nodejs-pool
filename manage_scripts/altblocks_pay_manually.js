"use strict";

const argv = require('minimist')(process.argv.slice(2), { '--': true });

let hashes = {};
for (const h of argv['--']) {
  hashes[h] = 1;
}

if (!argv.pay) {
        console.error("Please specify pay value in main currency");
        process.exit(1);
}
const pay = argv.pay;

require("../init_mini.js").init(function() {
        let changed = 0;
        let txn = global.database.env.beginTxn();
        let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        let blockData = global.protos.AltBlock.decode(data);
                        if (blockData.hash in hashes) {
                                console.log("Found altblock with " + blockData.hash + " hash");
                                blockData.pay_value = global.support.decimalToCoin(pay);
                                blockData.unlocked = false;
                                console.log("Put " + blockData.pay_value + " pay_value to block");
                                txn.putBinary(global.database.altblockDB, key, global.protos.AltBlock.encode(blockData));
                                console.log("Changed altblock");
                                changed = 1;
                        }
                });
        }
        cursor.close();
        txn.commit();
        if (!changed) console.log("Not found altblocks with specified hashes");
        process.exit(0);
});