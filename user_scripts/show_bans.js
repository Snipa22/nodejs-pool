"use strict";
const mysql = require("promise-mysql");
const async = require("async");

require("../init_mini.js").init(function() {
	async.waterfall([
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
			console.log("Done.");
			process.exit(0);
	        }
	]);
});
