"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.height) {
	console.error("Please specify block height to lock again (to pay it again)");
	process.exit(1);
}
const height = argv.height;

require("../init_mini.js").init(function() {
        let txn = global.database.env.beginTxn();
        let blockProto = txn.getBinary(global.database.blockDB, parseInt(height));
        if (blockProto !== null) {
            let blockData = global.protos.Block.decode(blockProto);
            blockData.unlocked = false;
            txn.putBinary(global.database.blockDB, height, global.protos.Block.encode(blockData));
        }
        txn.commit();
	console.log("Block on " + height + " height re-locked! Exiting!");
	process.exit(0);
});
