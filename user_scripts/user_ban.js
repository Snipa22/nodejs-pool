"use strict";
const cli = require("../script_utils.js")();
const printBans = require("./user_bans_common.js");
const insertBan = require("./user_ban_common.js");
const user = process.argv.length === 2 ? null : cli.arg("user", "Please specify user address to ban");
const reason = cli.get("reason") === null ? "Reported as botnet" : cli.arg("reason", "Please specify reason to ban");

cli.init(function() {
	if (user === null) {
		printBans(function () { process.exit(0); });
		return;
	}
	let validAddress = false;
	try {
		validAddress = global.coinFuncs.validateAddress(user);
	} catch (_error) { /* Malformed addresses may also be rejected by the decoder. */ }
	if (!validAddress) {
		console.error("Invalid XMR address. User was not banned.");
		process.exit(1);
		return;
	}
	insertBan(user, reason).then(function () {
		printBans(function () {
			console.log("Done. User was banned.");
			process.exit(0);
		});
	});
});
