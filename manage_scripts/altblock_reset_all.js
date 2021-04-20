'use strict';

require('../init_mini.js').init(function () {
    let txn = global.database.env.beginTxn();
    let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);

    let count = 0;
    let total = 0;
    for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        cursor.getCurrentBinary(function (key, data) {
            // jshint ignore:line
            try {
                let block = global.protos.AltBlock.decode(data);
                if (block.unlocked || block.pay_ready) {
                    block.unlocked = false;
                    block.pay_ready = false;

                    let buf = global.protos.AltBlock.encode(block);
                    txn.putBinary(global.database.altblockDB, key, buf);
                    console.log(key + ': ' + JSON.stringify(block));
                    count += 1;
                }
                total += 1;
            } catch (e) {
                console.error(`Failed to reset ${key}`);
                console.error(e);
            }
        });
    }
    console.log(`${count}/${total} block(s) reset`);
    cursor.close();
    txn.commit();
    process.exit(0);
});
