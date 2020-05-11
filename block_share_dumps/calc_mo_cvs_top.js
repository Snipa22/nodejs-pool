"use strict";

if (Boolean(process.stdin.isTTY) || process.argv.length !== 2) {
  console.log("Usage: unxz -c <block hash>.cvs.xz | node calc_mo_cvs_top.js");
  console.log("       wget -O - https://block-share-dumps.moneroocean.stream/<block hash>.cvs.xz | unxz -c | node calc_mo_cvs_top.js");
  process.exit(1);
}

let stdin = "";

process.stdin.on('data', function(data) {
  stdin += data.toString();
});

function human_hashrate(hashes) {
  const power = Math.pow(10, 2 || 0);
  if (hashes > 1000000000000) return String(Math.round((hashes / 1000000000000) * power) / power) +  " TH/s";
  if (hashes > 1000000000)    return String(Math.round((hashes / 1000000000) * power) / power) +  " GH/s";
  if (hashes > 1000000)       return String(Math.round((hashes / 1000000) * power) / power) +  " MH/s";
  if (hashes > 1000)          return String(Math.round((hashes / 1000) * power) / power) +  " KH/s";
  return Math.floor( hashes || 0 ) + " H/s"
};

process.stdin.on('end', function() {
  let pplns_window      = 0;
  let oldest_timestamp  = 0;
  let newest_timestamp  = 0;

  let wallets = {};

  let my_share_count    = 0;
  let my_xmr_diff       = 0;
  let my_xmr_diff_payed = 0;
  let my_coin_raw_diff  = {};
  let my_coin_xmr_diff  = {};

  for (let line of stdin.split("\n")) {
    if (line.substring(0, 1) == "#") continue;
    const items = line.split('\t');
    if (items.length < 7) {
      console.error("Skipped invalid line: " + line);
      continue;
    }
    const wallet         = items[0];
    const timestamp      = parseInt(items[1], 16);
    const raw_diff       = parseInt(items[2]);
    const count          = parseInt(items[3]);
    const coin           = items[4];
    const xmr_diff       = parseInt(items[5]);
    const xmr_diff_payed = items[6] == "" ? xmr_diff : parseInt(items[6]);
    pplns_window += xmr_diff;
    if (!oldest_timestamp || timestamp < oldest_timestamp) oldest_timestamp = timestamp;
    if (newest_timestamp < timestamp) newest_timestamp = timestamp;
    if (!(wallet in wallets)) wallets[wallet] = {
      share_count: 0,
      xmr_diff: 0,
      xmr_diff_payed: 0,
      coin_raw_diff: {},
      coin_xmr_diff: {},
    };
    wallets[wallet].share_count    += count;
    wallets[wallet].xmr_diff       += xmr_diff;
    wallets[wallet].xmr_diff_payed += xmr_diff_payed;
    if (!(coin in wallets[wallet].coin_raw_diff)) wallets[wallet].coin_raw_diff[coin] = 0;
    wallets[wallet].coin_raw_diff[coin] += raw_diff;
    if (!(coin in wallets[wallet].coin_xmr_diff)) wallets[wallet].coin_xmr_diff[coin] = 0;
    wallets[wallet].coin_xmr_diff[coin] += xmr_diff;
  }

  for (let wallet of Object.keys(wallets).sort((a, b) => (wallets[a].xmr_diff < wallets[b].xmr_diff) ? 1 : -1)) {
    console.log(wallet + ": " + wallets[wallet].xmr_diff);
  }

  process.exit(0);
});