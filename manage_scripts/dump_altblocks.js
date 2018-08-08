"use strict";

require("../init_mini.js").init(function() {
	let txn = global.database.env.beginTxn({readOnly: true});

	let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
	for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        	cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
			let blockData = global.protos.AltBlock.decode(data);
			console.log(key + ": " + JSON.stringify(blockData))
		});
	}
	cursor.close();
        txn.commit();
	process.exit(0);
});
