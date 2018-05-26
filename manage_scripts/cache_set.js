"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.key) {
	console.error("Please specify key");
	process.exit(1);
}
const key = argv.key;

if (!argv.value) {
	console.error("Please specify value");
	process.exit(1);
}
const value = argv.value;

require("../init_mini.js").init(function() {
	try {
		let value2 = JSON.parse(value);
		global.database.setCache(key, value2);
		process.exit(0);
	} catch(e) {
		console.error("Can't parse your value: " + value);
		process.exit(1);
	}
});

