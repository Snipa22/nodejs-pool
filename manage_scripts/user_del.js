"use strict";
const mysql = require("promise-mysql");
const async = require("async");
const argv = require('minimist')(process.argv.slice(2));

require("../tool_init.js").init(function() {
	if (!argv.user) {
		console.error("Please specify user address to delete");
		process.exit(1);
	}
	let parts = argv.user.split(".");
	let address = parts.length === 1 ? argv.user : parts[0];
	let payment_id = parts.length === 2 ? parts[1] : null;

	console.log("Address: " + address);
	console.log("PaymentID: " + payment_id);
	console.log("Max payment to remove: " + global.config.payout.walletMin);
	let rows2remove = 0;

	let where_str = payment_id === null ? "payment_address = '" + address + "' AND payment_id IS NULL"
	                                    : "payment_address = '" + address + "' AND payment_id = '" + payment_id + "'";

	async.waterfall([
		function (callback) {
			global.mysql.query("SELECT * FROM users WHERE username = ?", [argv.user]).then(function (rows) {
				if (rows.length > 1) {
					console.error("Too many users were selected!");
					process.exit(1);
				}
				console.log("Found rows in users table: " + rows.length);
				rows2remove += rows.length;
				callback();
			});
		},
		function (callback) {
			global.mysql.query("SELECT * FROM balance WHERE " + where_str).then(function (rows) {
				if (rows.length > 1) {
					console.error("Too many users were selected!");
					process.exit(1);
				}
				if (rows.length === 1 && rows[0].amount >= global.support.decimalToCoin(global.config.payout.walletMin)) {
					console.error("Too big payment left: " + global.support.coinToDecimal(rows[0].amount));
					process.exit(1);
				}
				console.log("Found rows in balance table: " + rows.length);
				rows2remove += rows.length;
				callback();
			});
		},
		function (callback) {
			global.mysql.query("SELECT * FROM payments WHERE " + where_str).then(function (rows) {
				console.log("Found rows in payments table: " + rows.length);
				rows2remove += rows.length;
				callback();
			});
		},
		function (callback) {
			let address     = global.database.getCache(argv.user);
			let stats       = global.database.getCache("stats:" + argv.user);
			let history     = global.database.getCache("history:" + argv.user);
			let identifiers = global.database.getCache(argv.user + '_identifiers');

			if (address != false) console.log("Cache key is not empty: " + argv.user);
			if (stats != false) console.log("Cache key is not empty: " + "stats:" + argv.user);
			if (history != false) console.log("Cache key is not empty: " + "history:" + argv.user);
			if (identifiers != false) console.log("Cache key is not empty: " + argv.user + '_identifiers');
			callback();

		},
		function (callback) {
			if (!rows2remove) { // to check that we accidently do not remove something usefull from LMDB cache
				console.error("User was not found in SQL. Refusing to proceed to LMDB cache cleaning");
				process.exit(1);
			}
			callback();

		},
		function (callback) {
			global.mysql.query("DELETE FROM users WHERE username = ?", [argv.user]).then(function (rows) {
				console.log("DELETE FROM users WHERE username = " + argv.user);
				callback();
			});
		},
		function (callback) {
			global.mysql.query("DELETE FROM balance WHERE " + where_str, [argv.user]).then(function (rows) {
				console.log("DELETE FROM balance WHERE " + where_str);
				callback();
			});
		},
		function (callback) {
			global.mysql.query("DELETE FROM payments WHERE " + where_str, [argv.user]).then(function (rows) {
				console.log("DELETE FROM payments WHERE " + where_str);
				callback();
			});
		},
		function (callback) {
			console.log("Deleting LMDB cache keys");
			let txn = global.database.env.beginTxn();
                        if (global.database.getCache(argv.user))                  txn.del(global.database.cacheDB, argv.user);
                        if (global.database.getCache("stats:" + argv.user))       txn.del(global.database.cacheDB, "stats:" + argv.user);
                        if (global.database.getCache("history:" + argv.user))     txn.del(global.database.cacheDB, "history:" + argv.user);
                        if (global.database.getCache(argv.user + '_identifiers')) txn.del(global.database.cacheDB, argv.user + '_identifiers');
			txn.commit();
			callback();
		},
		function (callback) {
			console.log("DONE");
			process.exit(0);
	        }
	]);
});
