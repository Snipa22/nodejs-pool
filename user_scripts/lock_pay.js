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
	async.waterfall([
		function (callback) {
			global.mysql.query("SELECT * FROM users WHERE username = ?", [user]).then(function (rows) {
				if (rows.length != 1) {
					console.error("User password and thus email is not yet set");
					process.exit(1);
				}
				callback();
			});
		},
		function (callback) {
			global.mysql.query("UPDATE users SET payout_threshold_lock = '1' WHERE username = ?", [user]).then(function (rows) {
				console.log("UPDATE users SET payout_threshold_lock = '1' WHERE username = " + user);
				callback();
			});
		},
		function (callback) {
			console.log("Done.");
			process.exit(0);
	        }
	]);
});
