"use strict";

require("../init_mini.js").init(function() {
	let txn = global.database.env.beginTxn({readOnly: true});
	let x = 0;
	let cursor = new global.database.lmdb.Cursor(txn, global.database.cacheDB);
	for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        	cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
			const data2 = JSON.parse(data);
			console.log(key + ": " + JSON.stringify(data2));
			if (++ x > 10) {
				cursor.close();
			        txn.commit();
				process.exit(0);
			}
		});
	}
	cursor.close();
        txn.commit();
	process.exit(0);
});
