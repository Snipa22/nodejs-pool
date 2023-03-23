"use strict";

require("../init_mini.js").init(function() {
	console.log("Cleaning up the alt block DB. Searching for items to delete");
	let txn = global.database.env.beginTxn({readOnly: true});
	let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
        let deleted = [];
	for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        	cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
			let blockData = global.protos.AltBlock.decode(data);
                        if (blockData.unlocked && Date.now() - blockData.timestamp > 365*24*60*60*1000) { 
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
});
