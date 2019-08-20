"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.port) {
	console.error("Please specify port");
	process.exit(1);
}
const port = argv.port;

if (!argv.hash) {
	console.error("Please specify height");
	process.exit(1);
}
const hash = argv.hash;

require("../init_mini.js").init(function() {
  global.coinFuncs.getPortAnyBlockHeaderByHash(port, hash, true, function (err_header, body_header) {
    console.log("err:"  + JSON.stringify(err_header));
    console.log("body:" + JSON.stringify(body_header));
    process.exit(0);
  });
});
