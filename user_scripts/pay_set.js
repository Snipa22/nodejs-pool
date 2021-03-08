"use strict";
const mysql = require("promise-mysql");
const async = require("async");
const argv = require('minimist')(process.argv.slice(2));

if (!argv.user) {
	console.error("Please specify user address to set");
	process.exit(1);
}
const user = argv.user;

require("../init_mini.js").init(function() {
        const pay = global.support.decimalToCoin(argv.pay ? argv.pay : 0.003);
	async.waterfall([
		function (callback) {
			global.mysql.query("UPDATE users SET payout_threshold=? WHERE user=?", [pay, user]).then(function (rows) {
				console.log("UPDATE users SET payout_threshold=" + pay + " WHERE username=" + user);
				callback();
			});
		},
		function (callback) {
			console.log("Done.");
			process.exit(0);
	        }
	]);
});
