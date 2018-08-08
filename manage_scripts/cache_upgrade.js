"use strict";

const argv = require('minimist')(process.argv.slice(2));
const user = argv.user ? argv.user : null;

require("../init_mini.js").init(function() {
	let txn = global.database.env.beginTxn({readOnly: true});
	let cursor = new global.database.lmdb.Cursor(txn, global.database.cacheDB);
	for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        	cursor.getCurrentString(function(key, data){  // jshint ignore:line
			if (key.length < 95) { // min XMR address length
				if (key.includes("history:") || key.includes("stats:") || key.includes("identifiers:")) {
					console.log(key + ": removing bad key");
					let txn2 = global.database.env.beginTxn();
					txn2.del(global.database.cacheDB, key);
					txn2.commit();
					return;
				}
				console.log("Skipping " + key + " key");
				return;
			}
			if (key.includes("history:") || key.includes("stats:") || key.includes("identifiers:")) return;
			if (user && !key.includes(user)) return;

			let txn2 = global.database.env.beginTxn();
			if (key.includes("_identifiers")) {
				let parts = key.split("_");
				let key2 = parts[0];
				if (global.database.getCache("identifiers:" + key2)) {
					console.log(key2 + ": removing outdated _identifiers");
					txn2.del(global.database.cacheDB, key);
				} else {
					console.log(key2 + ": moving _identifiers to identifiers:");
					txn2.putString(global.database.cacheDB, "identifiers:" + key2, data);
					txn2.del(global.database.cacheDB, key);
				}
			} else {
                        	try {
	                		let data2 = JSON.parse(data);
					if ("hash" in data2 && "lastHash" in data2) {
						if (global.database.getCache("stats:" + key)) {
							console.log(key + ": removing outdated stats");
							delete data2["hash"];
							delete data2["lastHash"];
							txn2.putString(global.database.cacheDB, key, JSON.stringify(data2));
						} else {
							console.log(key + ": moving old stats to stats:");
							let data3 = { hash: data2.hash, lastHash: data2.lastHash };
							delete data2["hash"];
							delete data2["lastHash"];
							txn2.putString(global.database.cacheDB, key, JSON.stringify(data2));
							txn2.putString(global.database.cacheDB, "stats:" + key, JSON.stringify(data3));
						}
					}
					if ("hashHistory" in data2) {
						if (global.database.getCache("history:" + key)) {
							console.log(key + ": removing outdated history");
							delete data2["hashHistory"];
							txn2.putString(global.database.cacheDB, key, JSON.stringify(data2));
						} else {
							console.log(key + ": moving old history to history:");
							let data3 = { hashHistory: data2.hashHistory };
							delete data2["hashHistory"];
							txn2.putString(global.database.cacheDB, key, JSON.stringify(data2));
							txn2.putString(global.database.cacheDB, "history:" + key, JSON.stringify(data3));
						}
					}
				} catch (e) {
					console.error("Bad cache data with " + key + " key");
				}
			}
			txn2.commit();
		});
	}
	cursor.close();
        txn.commit();
	process.exit(0);
});
