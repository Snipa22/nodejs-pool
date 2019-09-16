"use strict";
const mysql = require("promise-mysql");
const async = require("async");
const argv = require('minimist')(process.argv.slice(2));

if (!argv.user) {
	console.error("Please specify user address to set");
	process.exit(1);
}
if (!argv.pass) {
	console.error("Please specify user pass to set");
	process.exit(1);
}
const user = argv.user;
const pass = argv.pass;

require("../init_mini.js").init(function() {
	async.waterfall([
		function (callback) {
			global.mysql.query("SELECT * FROM users WHERE username = ?", [user]).then(function (rows) {
				if (rows.length == 1) {
					console.error("Your password is already set, so can not set it again");
   					console.log("Found rows in users table: " + rows.length);
					process.exit(1);
				}
				callback();
			});
		},
		function (callback) {
			global.mysql.query("INSERT INTO users (username, email, enable_email) VALUES (?, ?, 0)", [user, pass]).then(function (rows) {
				console.log("INSERT INTO users (username, email, enable_email) VALUES (" + user + ", " + pass + ", 0)");
				callback();
			});
		},
		function (callback) {
			console.log("Done.");
			process.exit(0);
	        }
	]);
});
