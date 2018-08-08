"use strict";

const argv = require('minimist')(process.argv.slice(2));
const user = argv.user ? argv.user : null;

require("../init_mini.js").init(function() {
	let txn = global.database.env.beginTxn({readOnly: true});
	let cursor = new global.database.lmdb.Cursor(txn, global.database.cacheDB);
	for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        	cursor.getCurrentString(function(key, data){  // jshint ignore:line
			if (!user || key.includes(user)) console.log(key + ": " + data);
		});
	}
	cursor.close();
        txn.commit();
	process.exit(0);
});
