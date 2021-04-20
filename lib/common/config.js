const db = require('./db');

async function load() {
    let config = {};
    const rows = await db.config.all();
    rows.forEach(row => {
        if (!config.hasOwnProperty(row.module)) {
            config[row.module] = {};
        }
        if (config[row.module].hasOwnProperty(row.item)) {
            return;
        }
        switch (row.item_type) {
            case 'int':
                config[row.module][row.item] = parseInt(row.item_value);
                break;
            case 'bool':
                config[row.module][row.item] = (row.item_value === "true");
                break;
            case 'string':
                config[row.module][row.item] = row.item_value;
                break;
            case 'float':
                config[row.module][row.item] = parseFloat(row.item_value);
                break;
        }
    });
    return config;
}

module.exports = {load};