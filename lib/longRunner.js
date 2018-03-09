"use strict";

console.log("Cleaning up the share DB");
global.database.cleanShareDB();
console.log("Done cleaning up the shareDB");
setInterval(function(){
    console.log("Cleaning up the share DB");
    global.database.cleanShareDB();
}, 4*60*60*1000);
