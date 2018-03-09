"use strict";

console.log("Cleaning up the share DB");
global.database.cleanShareDB();
console.log("Done cleaning up the shareDB");
setInterval(function(){
    console.log("Cleaning up the share DB");
    global.database.cleanShareDB();
}, 2*60*60*1000);
