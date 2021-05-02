"use strict";

const argv = require('minimist')(process.argv.slice(2));

require("../init_mini.js").init(function() {
	const xmr_balance = global.database.getCache("xmr_balance");
	if (xmr_balance !== false) {
		if (!xmr_balance.value || xmr_balance.value < 0) {
			console.error("Can't fix xmr_balance: " + JSON.stringify(xmr_balance));
			process.exit(1);
			return;
		} 
                const xmr_balance2 = { value: -xmr_balance.expected_increase, expected_increase: xmr_balance.expected_increase };
		console.log("In 10 seconds is going to change xmr_balance from " + JSON.stringify(xmr_balance) + " into " + JSON.stringify(xmr_balance2));
		setTimeout(10*1000, function() {
			global.database.setCache("xmr_balance", xmr_balance2);
			console.log("Done.");
			process.exit(0);
		});
	} else {
		console.error("Key xmr_balance is not found");
		process.exit(1);
	}
});

