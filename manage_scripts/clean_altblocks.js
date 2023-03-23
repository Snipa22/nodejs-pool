"use strict";

require("../init_mini.js").init(function() {
	console.log("Cleaning up the alt block DB. Searching for items to delete");
	let txn = global.database.env.beginTxn({readOnly: true});
	let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
        let deleted = [];
        let block_count = {};
	for (let found = cursor.goToLast(); found; found = cursor.goToPrev()) {
        	cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
			let blockData = global.protos.AltBlock.decode(data);
                        if (!(blockData.port in block_count)) block_count[blockData.port] = 0;
                        ++ block_count[blockData.port];
                        if (blockData.unlocked && (block_count[blockData.port] > 100000 || Date.now() - blockData.timestamp > 2*365*24*60*60*1000)) {
                           deleted.push(key);
                           console.log(JSON.stringify(blockData));
                        } else {
                           console.log("SKIP: " + JSON.stringify(blockData));
                        }
		});
	}

	cursor.close();
        txn.commit();

	console.log("Deleting altblock items: " + deleted.length);

        let chunkSize = 0;
        //txn = global.database.env.beginTxn();
        deleted.forEach(function(key) {
            ++ chunkSize;
            //txn.del(global.database.altblockDB, key);
      	    if (chunkSize > 500) {
	        //txn.commit();
		//txn = global.database.env.beginTxn();
                chunkSize = 0;
	    }
        });
        //txn.commit();
	process.exit(0);
});
