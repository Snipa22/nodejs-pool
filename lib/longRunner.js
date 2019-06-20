"use strict";

function cleanCacheDB() {
	console.log("Cleaning up the cache DB");
	let count = 0;
	let txn = global.database.env.beginTxn({readOnly: true});
	let cursor = new global.database.lmdb.Cursor(txn, global.database.cacheDB);
	for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        	cursor.getCurrentString(function(key, data){  // jshint ignore:line
			if (key.length < global.config.pool.address.length) return; // min XMR address length

			if (key.includes("identifiers:")) { // remove frozen worker names after 24h
				let parts = key.split(/:(.+)/);
				let key2 = parts[1];

	                        try {
		                	let data2 = JSON.parse(data);
					if (data2.length == 0) return;
					let isAlive = false;
					for (let i in data2) {
						let stats = global.database.getCache("stats:" + key2 + "_" + data2[i]);
						if (stats && Date.now() - stats.lastHash <= 24*60*60*1000) isAlive = true;
					}
					if (!isAlive) {
						data2 = [];
						let txn2 = global.database.env.beginTxn();
						txn2.putString(global.database.cacheDB, key, JSON.stringify(data2));
						txn2.commit();
					}
					
				} catch (e) {
					console.error("Bad cache data with " + key + " key");
				}

			} else if (key.includes("_") && !key.includes("history:") && !key.includes("stats:")) { // remove week old workers
				let stats = global.database.getCache("stats:" + key);
				if (!stats) return;
				if (!global.database.getCache("history:" + key)) return;
				if (Date.now() - stats.lastHash > 7*24*60*60*1000) {
					let txn2 = global.database.env.beginTxn();
					txn2.del(global.database.cacheDB, key);
					txn2.del(global.database.cacheDB, "history:" + key);
					txn2.del(global.database.cacheDB, "stats:" + key);
				        txn2.commit();
					++ count;
				}

			} else if (!key.includes("_") && key.includes("stats:")) { // zero frozen account hashrate after 24h
	                        try {
		                	let data2 = JSON.parse(data);
					if ((data2.hash || data2.hash2) && Date.now() - data2.lastHash > 24*60*60*1000) {
						data2.hash = data2.hash2 = 0;
						let txn2 = global.database.env.beginTxn();
						txn2.putString(global.database.cacheDB, key, JSON.stringify(data2));
						txn2.commit();
					}
				} catch (e) {
					console.error("Bad cache data with " + key + " key");
				}
				
			}
		});
	}

	cursor.close();
        txn.commit();
	console.log("Deleted cache items: " + count);
}

let saw_block_hash_before = {};

let cleanBlockBalanceTableQueue = async.queue(function (task, callback) {
    global.mysql.query("DELETE FROM block_balance WHERE hex = ?", [task.hex]).then(function () { return callback(true); });
}, 10);

function cleanBlockBalanceTable() {
	console.log("Cleaning up the block balance table");

        let locked_block_hashes = {};
        global.database.getValidLockedBlocks().forEach(function (block)    { locked_block_hashes[block.hash] = 1; });
        global.database.getValidLockedAltBlocks().forEach(function (block) { locked_block_hashes[block.hash] = 1; });

        let deleted_row_count = 0;
        global.mysql.query("SELECT DISTINCT hex FROM block_balance").then(function (rows) {
            rows.forEach(function (row) {
                if (row.hex in locked_block_hashes) {
                    console.log("Block hash is currently locked: " + row.hex); return;
                }
                if (row.hex in saw_block_hash_before) {
                    cleanBlockBalanceTableQueue.push(row, function () {});
                    delete saw_block_hash_before[row.hex];
                    ++ deleted_row_count;
                } else {
                   saw_block_hash_before[row.hex] = 1;
                }
            });
	    console.log("Finished cleaning the block balance table. Removed " + deleted_row_count + " rows.");
        });
}

console.log("Cleaning up the share DB");
global.database.cleanShareDB();
cleanCacheDB();
cleanBlockBalanceTable();

setInterval(function(){
	console.log("Cleaning up the share DB");
	global.database.cleanShareDB();
}, 4*60*60*1000);

// clean cache items
setInterval(function(){
	cleanCacheDB();
}, 24*60*60*1000);

// clean block balance table
setInterval(function(){
	cleanBlockBalanceTable();
}, 60*1000);
