"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.port) {
	console.error("Please specify port");
	process.exit(1);
}
const port = argv.port;

if (!argv.hash) {
	console.error("Please specify hash");
	process.exit(1);
}
const hash = argv.hash;

require("../init_mini.js").init(function() {
  global.coinFuncs.getLastBlockHeader(function (err, last_block_body) {
    if (err !== null){
      console.error("Can't get last block info");
      process.exit(0);
    }
    global.coinFuncs.getPortAnyBlockHeaderByHash(port, hash, true, function (err_header, body_header) {
      if (err_header) {
        console.error("Can't get block info");
        console.error("err:"  + JSON.stringify(err_header));
        console.error("body:" + JSON.stringify(body_header));
        process.exit(0);
      }
      if (!body_header.timestamp) {
        console.error("Can't get block timestamp: " + JSON.stringify(body_header));
        process.exit(0);
      }
      if (!body_header.difficulty) {
        console.error("Can't get block difficilty: " + JSON.stringify(body_header));
        process.exit(0);
      }
      if (!body_header.height) {
        console.error("Can't get block height: " + JSON.stringify(body_header));
        process.exit(0);
      }
  
      global.database.storeAltBlock(body_header.timestamp, global.protos.AltBlock.encode({
        hash:          hash,
        difficulty:    body_header.difficulty,
        shares:        0,
        timestamp:     body_header.timestamp,
        poolType:      global.protos.POOLTYPE.PPLNS,
        unlocked:      false,
        valid:         true,
        port:          port,
        height:        body_header.timestamp,
        anchor_height: last_block_body.height
      }), function(data){
        if (!data){
          console.error("Block not stored");
        } else {
          console.log("Block with " + port + " port and " + hash + " stored");
        }
        process.exit(0);
      });
    });
  });
});

