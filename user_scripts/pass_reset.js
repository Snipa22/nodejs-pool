"use strict";
const mysql = require("promise-mysql");
const async = require("async");
const argv = require('minimist')(process.argv.slice(2));

if (!argv.user) {
	console.error("Please specify user address to delete");
	process.exit(1);
}
const user = argv.user;

require("../init_mini.js").init(function() {
	async.waterfall([
		function (callback) {
			global.mysql.query("SELECT * FROM users WHERE username = ?", [user]).then(function (rows) {
				if (rows.length != 1) {
					console.error("Your password is not yet set. To do that you need to set password field in your miner to \"<your miner name>:<password>\", where <your miner name> is any name (without : character) and <password> is your password (depending on miner password can be in in command line, config.json or config.txt files). Optionally you can use your email as your password if you want notifications about miner downtimes from the pool. You need to make sure you restart your miner and your miner submits at least one valid share for password to be set.");
					process.exit(1);
				}
				console.log("Found rows in users table: " + rows.length);
				callback();
			});
		},
		function (callback) {
			global.mysql.query("DELETE FROM users WHERE username = ?", [user]).then(function (rows) {
				console.log("DELETE FROM users WHERE username = " + user);
				callback();
			});
		},
		function (callback) {
			console.log("Done. Please do not forget to restart your miner to apply new password and set payment threshold since it was reset as well");
			process.exit(0);
	        }
	]);
});
