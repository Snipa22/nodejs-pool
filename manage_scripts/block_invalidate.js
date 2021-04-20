'use strict';

const argv = require('minimist')(process.argv.slice(2));

const hash = argv.hash;
if (!hash) {
    console.error('Please specify a block hash');
    process.exit(1);
}

require('../init_mini.js').init(function () {
    let txn = global.database.env.beginTxn();
    let cursor = new global.database.lmdb.Cursor(txn, global.database.blockDB);
    let is_found = true;
    for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        cursor.getCurrentBinary(function (key, data) {
            // jshint ignore:line
            let blockData = global.protos.Block.decode(data);
            if (blockData.hash === hash) {
                is_found = true;
                if (!blockData.valid) {
                    console.log('block with ' + hash + ' hash was already invalid! Exiting!');
                    cursor.close();
                    txn.commit();
                    process.exit(0);
                }
                blockData.valid = false;
                txn.putBinary(global.database.blockDB, key, global.protos.Block.encode(blockData));
                cursor.close();
                txn.commit();
                console.log('block with ' + hash + ' hash was invalidated! Exiting!');
                process.exit(0);
            }
        });
    }

    cursor.close();
    txn.commit();
    if (!is_found) {
        console.log('Not found block with ' + hash + ' hash');
        process.exit(1);
    }
    process.exit(0);
});
