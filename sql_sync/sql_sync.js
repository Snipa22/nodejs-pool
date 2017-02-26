"use strict";
let mysql = require("promise-mysql");
let fs = require("fs");
let config = fs.readFileSync("../config.json");
let sql_schema = fs.readFileSync("config_entries.json");
let async = require("async");

global.config = JSON.parse(config);
global.mysql = mysql.createPool(global.config.mysql);
global.schema = JSON.parse(sql_schema);

// Config Table Layout
// <module>.<item>

let loopCount = 0;
let updatedCount = 0;
async.eachSeries(global.schema, function(entry, callback){
    global.mysql.query("SELECT * FROM config WHERE module = ? AND item = ?", [entry.module, entry.item]).then(function(rows){
        loopCount += 1;
        if (rows.length > 0){
            callback();
        }
        updatedCount += 1;
        global.mysql.query("INSERT INTO config (module, item, item_value, item_type, Item_desc) VALUES (?, ?, ?, ?, ?)", [entry.module, entry.item, entry.item_value, entry.item_type, entry.Item_desc]).then(function(){
            callback();
        });
    });
}, function(){
    console.log("Updated SQL schema with "+updatedCount+" new rows!  Exiting!");
    process.exit();
});