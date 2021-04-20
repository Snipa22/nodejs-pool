'use strict';
const db = require('./db');
const sql = require('./sql');
const { load: loadConfig } = require('./config');
const monero = require('./monero');
const aux = require('./aux');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHex(bytes) {
    return Array.from(bytes, (b) => ('0' + b.toString(16)).slice(-2)).join('');
}

// Works for numbers and bignum
function compareGte(l, r) {
    if (typeof l === 'object') return l.ge(r);
    if (typeof r === 'object') return !r.lt(l);
    return l >= r;
}

module.exports = {
    aux,
    compareGte,
    db,
    loadConfig,
    monero,
    sleep,
    sql,
    toHex,
};
