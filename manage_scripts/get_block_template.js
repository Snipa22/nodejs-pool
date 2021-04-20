'use strict';

require('../init_mini.js').init(function () {
    global.coinFuncs.getBlockTemplate(function (err, body_header) {
        if (err) {
            console.error(err);
            return;
        }
        console.log('body:' + JSON.stringify(body_header, null, 4));
        process.exit(0);
    });
});
