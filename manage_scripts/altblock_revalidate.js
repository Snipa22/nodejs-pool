"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.hash) {
	console.error("Please specify altblock hash");
	process.exit(1);
}
const hash = argv.hash;

require("../init_mini.js").init(function() {
	let txn = global.database.env.beginTxn();
	let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
	let is_found = true;
	for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        	cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
			let blockData = global.protos.AltBlock.decode(data);
			if (blockData.hash === hash) {
			        is_found = true;
				global.coinFuncs.getPortBlockHeaderByHash(blockData.port, hash, (err, body) => {
					if (err !== null || !body.reward) {
		        			console.log("Altblock with " + hash + " hash still has invalid hash for " + blockData.port + " port! Exiting!");
						cursor.close();
						txn.commit();
						process.exit(1);
					}
					blockData.valid = true;
					blockData.unlocked = false;
		                        if (blockData.value != body.reward) console.log("Changing alt-block value from " + blockData.value + " to " + body.reward);
                                        blockData.value = body.reward;
					txn.putBinary(global.database.altblockDB, key, global.protos.AltBlock.encode(blockData));
					cursor.close();
					txn.commit();
					console.log("Altblock with " + hash + " hash was validated! Exiting!");
					process.exit(0);
				});
			}
		});
        }
        if (!is_found) {
	        cursor.close();
	        txn.commit();
		console.log("Not found altblock with " + hash + " hash");
		process.exit(1);
	}
});
