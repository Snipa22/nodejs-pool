"use strict";

function init(callback) {

	let fs = require("fs");
	let mysql = require("promise-mysql");

	let config = fs.readFileSync("../config.json");
	let coinConfig = fs.readFileSync("../coinConfig.json");
	let protobuf = require('protocol-buffers');

	global.support = require("./lib/support.js")();
	global.config = JSON.parse(config);
	global.mysql = mysql.createPool(global.config.mysql);
	global.protos = protobuf(fs.readFileSync('../lib/data.proto'));

	global.mysql.query("SELECT * FROM config").then(function (rows) {
		rows.forEach(function (row){
			if (!global.config.hasOwnProperty(row.module)) global.config[row.module] = {};
			if (global.config[row.module].hasOwnProperty(row.item)) return;
			switch(row.item_type){
				case 'int':    global.config[row.module][row.item] = parseInt(row.item_value); break;
				case 'bool':   global.config[row.module][row.item] = (row.item_value === "true"); break;
				case 'string': global.config[row.module][row.item] = row.item_value; break;
				case 'float':  global.config[row.module][row.item] = parseFloat(row.item_value); break;
			}
		});

	}).then(function(){
		global.config['coin'] = JSON.parse(coinConfig)[global.config.coin];
		let coinInc = require("." + global.config.coin.funcFile);
		global.coinFuncs = new coinInc();
		let comms = require('./lib/local_comms');
		global.database = new comms();
		global.database.initEnv();
	
	}).then(function(){
	        callback();
	});
}
	
module.exports = {
	init: init
};	