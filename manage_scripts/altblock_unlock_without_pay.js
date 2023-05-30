"use strict";

const argv = require('minimist')(process.argv.slice(2), { '--': true });

let hashes = [];
for (const h of argv['--']) {
  hashes.push(h);
}

require("../init_mini.js").init(function() {
        hashes.forEach(function(hash) {
          global.database.unlockAltBlock(hash);
    	  console.log("Altblock with " + hash + " hash un-locked!");
        })
	process.exit(0);
});
