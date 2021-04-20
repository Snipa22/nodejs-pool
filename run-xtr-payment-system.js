const mysql = require('promise-mysql');

global.support = require('./lib/support.js')();
global.mysql = mysql.createPool({
    connectionLimit: 20,
    host: 'db',
    database: 'pool',
    user: 'pool',
    password: 'password',
});
global.config = {
    coin: { sigDigits: 1000000, feePerGram: 25 },
};

global.mysql
    .query('SELECT * FROM config')
    .then(function (rows) {
        rows.forEach(function (row) {
            if (!global.config.hasOwnProperty(row.module)) {
                global.config[row.module] = {};
            }
            if (global.config[row.module].hasOwnProperty(row.item)) {
                return;
            }
            switch (row.item_type) {
                case 'int':
                    global.config[row.module][row.item] = parseInt(row.item_value);
                    break;
                case 'bool':
                    global.config[row.module][row.item] = row.item_value === 'true';
                    break;
                case 'string':
                    global.config[row.module][row.item] = row.item_value;
                    break;
                case 'float':
                    global.config[row.module][row.item] = parseFloat(row.item_value);
                    break;
            }
        });
    })
    .then(() => {
        require('./lib/payment_systems/xtr.js');
    });
