"use strict";
const mysql = require("promise-mysql");
const async = require("async");
const argv = require('minimist')(process.argv.slice(2));

if (!argv.user) {
	console.error("Please specify user address to ban");
	process.exit(1);
}
const user = argv.user;

if (!argv.reason) {
	console.error("Please specify reason to ban");
	process.exit(1);
}
const reason = argv.reson;

require("../init_mini.js").init(function() {
	async.waterfall([
		function (callback) {
			global.mysql.query('INSERT INTO bans (mining_address, reason) VALUES (?, ?)', [user, reason]).then(function (rows) {
				callback();
			});
		},
		function (callback) {
			global.mysql.query("SELECT * FROM bans").then(function (rows) {
				for (let i in rows) {
					const row = rows[i];
					console.log(row.mining_address + ": " + row.reason);
				}
				callback();
			});
		},
		function (callback) {
			console.log("Done. User was banned.");
			process.exit(0);
	        }
	]);
});
