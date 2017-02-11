"use strict";
let mysql = require("promise-mysql");
let fs = require("fs");
let config = fs.readFileSync("../config.json");
let sql_schema = fs.readFileSync("config_entries.json");

global.config = JSON.parse(config);
global.mysql = mysql.createPool(global.config.mysql);
global.schema = JSON.parse(sql_schema);

// Config Table Layout
// <module>.<item>

let loopCount = 0;
let updatedCount = 0;
global.schema.forEach(function(entry){
    loopCount += 1;
    global.mysql.query("SELECT * FROM config WHERE module = ? AND item = ?", [entry.module, entry.item]).then(function(rows){
        if (rows.length > 0){
            return;
        }
        updatedCount += 1;
        global.mysql.query("INSERT INTO config (module, item, item_value, item_type, Item_desc) VALUES (?, ?, ?, ?, ?)", [entry.module, entry.item, entry.item_value, entry.item_type, entry.Item_desc]);
        if(loopCount === global.schema.length){
            console.log("Updated SQL schema with "+updatedCount+" new rows!  Exiting!");
            process.exit();
        }
    });
});