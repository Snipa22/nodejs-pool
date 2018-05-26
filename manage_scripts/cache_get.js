"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.key) {
	console.error("Please specify key");
	process.exit(1);
}
const key = argv.key;

require("../init_mini.js").init(function() {
	let value = global.database.getCache(key);
	if (value !== false) {
		console.log(JSON.stringify(value));
		process.exit(0);
	} else {
		console.error("Key is not found");
		process.exit(1);
	}
});

