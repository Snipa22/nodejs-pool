"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.port) {
	console.error("Please specify port");
	process.exit(1);
}
const port = argv.port;

global.coinFuncs.getPortLastBlockHeader(port, function (err_header, body_header) {
   console.log(JSON.stringify(err_header));
   console.log(JSON.stringify(body_header));
});
