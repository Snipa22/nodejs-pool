"use strict";

const {mysql} = global;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOne(sql, args) {
    let results = await fetchMany(sql, args);
    if (results.length === 0) {
        return null;
    } else {
        return results[0];
    }
}

function fetchMany(sql, args) {
    return execute(sql, args);
}

async function execute(sql, args) {
    return await new Promise((resolve, reject) => {
        mysql.query(sql, args, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

const MERGE_MINING_ADDR_DELIM = '::';
const TARI_ADDRESS_REGEX = new RegExp("[0-9a-fA-F]{64}");
function tryParseMergeMiningAddress(addr) {
    const parts = addr.split(MERGE_MINING_ADDR_DELIM, 2);
    if (parts.length !== 2) {
        throw new Error("Invalid Tari merge mining address: did not contain 2 delimited addresses");
    }
    const [tari, monero]= parts;
    if (!TARI_ADDRESS_REGEX.test(tari)) {
        throw new Error("Invalid Tari merge mining address: invalid characters or incorrect length");
    }

    return {
        tari,
        monero,
    };
}

function toHex(bytes) {
    return Array.from(bytes, b => ('0' + b.toString(16)).slice(-2)).join('');
}

module.exports = {
    sleep,
    tryParseMergeMiningAddress,
    toHex,
    sql: {
        escape: (...args) => mysql.escape(...args),
        execute,
        fetchMany,
        fetchOne,
    },
};
