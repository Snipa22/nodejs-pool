"use strict";

const async = require("async");

function cleanCacheDB() {
	console.log("Cleaning up the cache DB. Searching for items to delete/update");
	let txn = global.database.env.beginTxn({readOnly: true});
	let cursor = new global.database.lmdb.Cursor(txn, global.database.cacheDB);
        let updated = {};
        let deleted = [];
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
                                                updated[key] = JSON.stringify([]);
					}
					
				} catch (e) {
					console.error("Bad cache data with " + key + " key");
				}

			} else if (key.includes("_") && !key.includes("history:") && !key.includes("stats:")) { // remove week old workers
				let stats = global.database.getCache("stats:" + key);
				if (!stats) return;
				if (!global.database.getCache("history:" + key)) return;
				if (Date.now() - stats.lastHash > 7*24*60*60*1000) {
                                        deleted.push(key);
                                        deleted.push("history:" + key);
                                        deleted.push("stats:" + key);
				}

			} else if (!key.includes("_") && key.includes("stats:")) { // zero frozen account hashrate after 24h
	                        try {
		                	let data2 = JSON.parse(data);
					if ((data2.hash || data2.hash2) && Date.now() - data2.lastHash > 24*60*60*1000) {
						data2.hash = data2.hash2 = 0;
                                                updated[key] = JSON.stringify(data2);
					}
				} catch (e) {
					console.error("Bad cache data with " + key + " key");
				}
				
			}
		});
	}

	cursor.close();
        txn.commit();

	console.log("Deleting cache items: " + deleted.length);

        let chunkSize = 0;
        txn = global.database.env.beginTxn();
        deleted.forEach(function(key) {
            ++ chunkSize;
            txn.del(global.database.cacheDB, key);
      	    if (chunkSize > 500) {
	        txn.commit();
		txn = global.database.env.beginTxn();
                chunkSize = 0;
	    }
        });
        txn.commit();

        console.log("Updating cache items: " + Object.keys(updated).length);

        chunkSize = 0;
        txn = global.database.env.beginTxn();
        for (const [key, value] of Object.entries(updated)) {
            ++ chunkSize;
            txn.putString(global.database.cacheDB, key, value);
      	    if (chunkSize > 500) {
	        txn.commit();
		txn = global.database.env.beginTxn();
                chunkSize = 0;
	    }
        }
        txn.commit();
}

let saw_block_hash_before = {};

let cleanBlockBalanceTableQueue = async.queue(function (task, callback) {
    global.mysql.query("DELETE FROM block_balance WHERE hex = ?", [task.hex]).then(function () { return callback(true); });
}, 10);

setInterval(function(queue_obj){
    if (queue_obj.length()){
        console.log("Remove block balance queue length: " + queue_obj.length());
    }
}, 60*1000, cleanBlockBalanceTableQueue);

function cleanBlockBalanceTable() {
	console.log("Cleaning up the block balance table");

        let locked_block_hashes = {};
        global.database.getValidLockedBlocks().forEach(function (block)    { locked_block_hashes[block.hash] = 1; });
        global.database.getValidLockedAltBlocks().forEach(function (block) { locked_block_hashes[block.hash] = 1; });

        console.log("Starting cleaning the block balance table. Found " +  Object.keys(locked_block_hashes).length + " locked blocks");
        global.mysql.query("SELECT hex FROM paid_blocks WHERE paid_time > (NOW() - INTERVAL 7 DAY)").then(function (rows_keep) {
            console.log("Got " + rows_keep.length + " recent blocks");
            rows_keep.forEach(function (row) { locked_block_hashes[row.hex] = 1; });
            let deleted_row_count = 0;
            global.mysql.query("SELECT DISTINCT hex FROM block_balance").then(function (rows) {
                console.log("Got " + rows.length + " block balance blocks");
                rows.forEach(function (row) {
                    if (row.hex in locked_block_hashes) return;
                    if (row.hex in saw_block_hash_before) {
                        cleanBlockBalanceTableQueue.push(row, function () {});
                        delete saw_block_hash_before[row.hex];
                        ++ deleted_row_count;
                    } else {
                       saw_block_hash_before[row.hex] = 1;
                    }
                });
	        console.log("Finished preparing the block balance table. Removing " + deleted_row_count + " rows (" + Object.keys(locked_block_hashes).length + " locked).");
            });
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
}, 24*60*60*1000);
