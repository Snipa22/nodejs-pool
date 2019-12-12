"use strict";

if (Boolean(process.stdin.isTTY) || process.argv.length !== 3) {
  console.log("Usage: unxz -c <block hash>.cvs.xz | node calc_mo_cvs.js <your Monero wallet address>");
  console.log("       wget -O - https://moneroocean-block-share-dumps.s3.us-east-2.amazonaws.com/<block hash>.cvs.xz | unxz -c | node calc_mo_cvs.js <your Monero wallet address>");
  process.exit(1);
}

const my_wallet = process.argv[2].slice(-16);

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
    if (wallet === my_wallet) {
      my_share_count    += count;
      my_xmr_diff       += xmr_diff;
      my_xmr_diff_payed += xmr_diff_payed;
      if (!(coin in my_coin_raw_diff)) my_coin_raw_diff[coin] = 0;
      my_coin_raw_diff[coin] += raw_diff;
      if (!(coin in my_coin_xmr_diff)) my_coin_xmr_diff[coin] = 0;
      my_coin_xmr_diff[coin] += xmr_diff;
    }
  }

  console.log("PPLNS window size:            \t" + ((newest_timestamp - oldest_timestamp)/1000/60/60).toFixed(2) + " hours");
  console.log("PPLNS window size:            \t" + pplns_window + " xmr hashes");
  console.log("Pool XMR normalized hashrate: \t" + human_hashrate(pplns_window / (newest_timestamp - oldest_timestamp) * 1000));
  console.log("");
  console.log("Your submitted shares:        \t" + my_share_count);
  console.log("Your payment:                 \t" + ((my_xmr_diff_payed / pplns_window) * 100).toFixed(6) + "% (" + my_xmr_diff_payed + " xmr hashes)");
  console.log("Your XMR normalized hashrate: \t" + human_hashrate(my_xmr_diff_payed / (newest_timestamp - oldest_timestamp) * 1000));
  console.log("");
  console.log("You mined these coins:");
  for (let coin of Object.keys(my_coin_raw_diff).sort()) {
    console.log("\t" + coin + ": " + my_coin_raw_diff[coin] + " raw coin hashes (" + ((my_coin_xmr_diff[coin] / my_xmr_diff) * 100).toFixed(6) + "% of XMR normalized hashrate)");
  }

  process.exit(0);
});