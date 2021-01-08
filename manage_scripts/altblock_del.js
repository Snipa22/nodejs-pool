"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.timestamp) {
	console.error("Please specify altblock time");
	process.exit(1);
}
const timestamp = argv.timestamp;

require("../init_mini.js").init(function() {
        let txn = global.database.env.beginTxn();
	txn.del(global.database.altblockDB, timestamp);
        txn.commit();
	console.log("Altblock with " + timestamp + " timestamp removed! Exiting!");
	process.exit(0);
});
