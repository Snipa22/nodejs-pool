"use strict";
const mysql = require("promise-mysql");
const async = require("async");
const argv = require('minimist')(process.argv.slice(2));

if (!argv.old_user) {
	console.error("Please specify old_user address to move balance from");
	process.exit(1);
}
const old_user = argv.old_user;

if (!argv.new_user) {
	console.error("Please specify new_user address to move balance to");
	process.exit(1);
}
const new_user = argv.new_user;

require("../init_mini.js").init(function() {
	const old_parts = old_user.split(".");
	const old_address = old_parts.length === 1 ? old_user : old_parts[0];
	const old_payment_id = old_parts.length === 2 ? old_parts[1] : null;

	const new_parts = new_user.split(".");
	const new_address = new_parts.length === 1 ? new_user : new_parts[0];
	const new_payment_id = new_parts.length === 2 ? new_parts[1] : null;

	console.log("Old Address: " + old_address);
	console.log("Old PaymentID: " + old_payment_id);
	console.log("New Address: " + new_address);
	console.log("New PaymentID: " + new_payment_id);

	const old_where_str = old_payment_id === null ? "payment_address = '" + old_address + "' AND payment_id IS NULL"
	                                              : "payment_address = '" + old_address + "' AND payment_id = '" + old_payment_id + "'";

	const new_where_str = new_payment_id === null ? "payment_address = '" + new_address + "' AND payment_id IS NULL"
	                                              : "payment_address = '" + new_address + "' AND payment_id = '" + new_payment_id + "'";

	let old_amount;

	async.waterfall([
		function (callback) {
			global.mysql.query("SELECT * FROM balance WHERE " + old_where_str).then(function (rows) {
				if (rows.length != 1) {
					console.error("Can't find old_user!");
					process.exit(1);
				}
				old_amount = rows[0].amount;
				console.log("Old address amount: " + global.support.coinToDecimal(old_amount));
				console.log("Old address last update time: " + rows[0].last_edited);
				callback();
			});
		},
		function (callback) {
			global.mysql.query("SELECT * FROM balance WHERE " + new_where_str).then(function (rows) {
				if (rows.length != 1) {
					console.error("Can't find new_user!");
					process.exit(1);
				}
				console.log("New address amount: " + global.support.coinToDecimal(rows[0].amount));
				callback();
			});
		},
		function (callback) {
			global.mysql.query("UPDATE balance SET amount = '0' WHERE " + old_where_str).then(function (rows) {
				console.log("UPDATE balance SET amount = '0' WHERE " + old_where_str);
				callback();
			});
		},
		function (callback) {
			global.mysql.query("UPDATE balance SET amount = amount + " + old_amount + " WHERE " + new_where_str).then(function (rows) {
				console.log("UPDATE balance SET amount = amount + " + old_amount + " WHERE " + new_where_str);
				callback();
			});
		},
		function (callback) {
			global.mysql.query("SELECT * FROM balance WHERE " + old_where_str).then(function (rows) {
				console.log("New old address amount: " + global.support.coinToDecimal(rows[0].amount));
				callback();
			});
		},
		function (callback) {
			global.mysql.query("SELECT * FROM balance WHERE " + new_where_str).then(function (rows) {
				console.log("New new address amount: " + global.support.coinToDecimal(rows[0].amount));
				callback();
			});
		},
		function (callback) {
			console.log("DONE");
			process.exit(0);
	        }
	]);
});
