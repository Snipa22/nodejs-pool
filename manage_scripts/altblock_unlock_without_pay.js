"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.hash) {
	console.error("Please specify altblock hash to unlock it (and avoid payment)");
	process.exit(1);
}
const hash = argv.hash;

require("../init_mini.js").init(function() {
	global.database.unlockAltBlock(hash);
	console.log("Altblock " + hash + " un-locked! Exiting!");
	process.exit(0);
});
