"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.timestamp) {
	console.error("Please specify altblock time");
	process.exit(1);
}
const timestamp = argv.timestamp;

if (!argv.body) {
	console.error("Please specify altblock body");
	process.exit(1);
}
const body = argv.body;
let body2;

try { body2 = JSON.parse(body); } catch(e) {
	console.error("Can't parse altblock body: " + body);
	process.exit(1);
}

require("../init_mini.js").init(function() {
	const body3 = {
		"hash":          body2.hash,
		"difficulty":    body2.difficulty,
		"port":          body2.port,
		"height":        body2.height,
		"value":         body2.value,
		"anchor_height": body2.anchor_height,
		"timestamp":     timestamp * 1000,
		"shares":        body2.shares || body2.difficulty,
		"poolType":      body2.poolType || 0,
		"unlocked":      body2.unlocked || false,
		"valid":         body2.valid || true,
		"pay_value":     body2.pay_value || 0,
		"pay_stage":     body2.pay_stage || "",
		"pay_status":    body2.pay_status || ""
	};
	if (typeof (body3.hash) === 'undefined' ||
	    typeof (body3.difficulty) === 'undefined' ||
	    typeof (body3.shares) === 'undefined' ||
	    typeof (body3.timestamp) === 'undefined' ||
	    typeof (body3.poolType) === 'undefined' ||
	    typeof (body3.unlocked) === 'undefined' ||
	    typeof (body3.valid) === 'undefined' ||
	    typeof (body3.port) === 'undefined' ||
	    typeof (body3.height) === 'undefined' ||
	    typeof (body3.anchor_height) === 'undefined' ||
	    typeof (body3.value) === 'undefined' ||
	    typeof (body3.pay_value) === 'undefined' ||
	    typeof (body3.pay_stage) === 'undefined' ||
	    typeof (body3.pay_status) === 'undefined') {
		console.error("Altblock body is invalid: " + JSON.stringify(body3));
		process.exit(1);
        }
        const body4 = global.protos.AltBlock.encode(body3);
        let txn = global.database.env.beginTxn();
	txn.putBinary(global.database.altblockDB, timestamp, body4);
        txn.commit();
	console.log("Altblock with " + timestamp + " timestamp added! Exiting!");
	process.exit(0);
});
