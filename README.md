Pool Design/Theory
==================
The nodejs-pool is built around a small series of core daemons that share access to a single LMDB table for tracking of shares, with MySQL being used to centralize configurations and ensure simple access from local/remote nodes.  The core daemons follow:
```text
api - Main API for the frontend to use and pull data from.  Expects to be hosted at  /
remoteShare - Main API for consuming shares from remote/local pools.  Expects to be hosted at /leafApi
pool - Where the miners connect to.
longRunner - Database share cleanup.
payments - Handles all payments to workers.
blockManager - Unlocks blocks and distributes payments into MySQL
worker - Does regular processing of statistics and sends status e-mails for non-active miners.
```
API listens on port 8001, remoteShare listens on 8000

moneroocean.stream (The reference implementation) uses the following setup:  
* https://moneroocean.stream is hosted on its own server, as the main website is a static frontend
* https://api.moneroocean.stream hosts api, remoteShare, longRunner, payments, blockManager, worker, as these must all be hosted with access to the same LMDB database.

Sample Caddyfile for API:
```text
https://api.moneroocean.stream {
    proxy /leafApi 127.0.0.1:8000
    proxy / 127.0.0.1:8001
    cors
    gzip
}
```

It is critically important that your webserver does not truncate the `/leafApi` portion of the URL for the remoteShare daemon, or it will not function!  Local pool servers DO use the remoteShare daemon, as this provides a buffer in case of an error with LMDB or another bug within the system, allowing shares and blocks to queue for submission as soon as the leafApi/remoteShare daemons are back up and responding with 200's.

Setup Instructions
==================

Server Requirements
-------------------
* 4 Gb Ram
* 2 CPU Cores (with AES_NI)
* 150 Gb SSD-Backed Storage - If you're doing a multi-server install, the leaf nodes do not need this much storage.  They just need enough storage to hold the blockchain for your node.  The pool comes configured to use up to 60Gb of storage for LMDB.  Assuming you have the longRunner worker running, it should never get near this size, but be aware that it /can/ bloat readily if things error, so be ready for this!
* Notably, this happens to be approximately the size of a 4Gb linode instance, which is where the majority of automated deployment testing happened!

Pre-Deploy
----------
* If you're planning on using e-mail, you'll want to setup an account at https://mailgun.com (It's free for 10k e-mails/month!), so you can notify miners.  This also serves as the backend for password reset emails, along with other sorts of e-mails from the pool, including pool startup, pool Monerod daemon lags, etc so it's highly suggested!
* Pre-Generate the wallets, or don't, it's up to you!  You'll need the addresses after the install is complete, so I'd suggest making sure you have them available.  Information on suggested setups are found below.
* If you're going to be offering PPS, PLEASE make sure you load the pool wallet with XMR before you get too far along.  Your pool will trigger PPS payments on its own, and fairly readily, so you need some float in there!
* Make a non-root user, and run the installer from there!

Deployment via Installer
------------------------

1. Add your user to `/etc/sudoers`, this must be done so the script can sudo up and do it's job.  We suggest passwordless sudo.  Suggested line: `<USER> ALL=(ALL) NOPASSWD:ALL`.  Our sample builds use: `pooldaemon ALL=(ALL) NOPASSWD:ALL`
2. Run the [deploy script](https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/deploy.bash) as a **NON-ROOT USER**.  This is very important!  This script will install the pool to whatever user it's running under!  Also.  Go get a coffee, this sucker bootstraps the monero installation.
3. Once it's complete, change as `config.json` appropriate.  It is pre-loaded for a local install of everything, running on 127.0.0.1.  This will work perfectly fine if you're using a single node setup.  You'll also want to set `bind_ip` to the external IP of the pool server, and `hostname` to the resolvable hostname for the pool server. `pool_id` is mostly used for multi-server installations to provide unique identifiers in the backend. You will also want to run: source ~/.bashrc  This will activate NVM and get things working for the following pm2 steps.
4. You'll need to change the API endpoint for the frontend code in the `poolui/build/globals.js` and `poolui/build/globals.default.js` -- This will usually be `http(s)://<your server FQDN>/api` unless you tweak caddy!
5. The default database directory `/home/<username>/pool_db/` is already been created during startup. If you change the `db_storage_path` just make sure your user has write permissions for new path. Run: `pm2 restart api` to reload the API for usage.  
6. Hop into the web interface (Should be at `http://<your server IP>/admin.html`), then login with `Administrator/Password123`, **MAKE SURE TO CHANGE THIS PASSWORD ONCE YOU LOGIN**. *<- This step is currently not active, we're waiting for the frontend to catch up!  Head down to the Manual SQL Configuration to take a look at what needs to be done by hand for now*.
7. From the admin panel, you can configure all of your pool's settings for addresses, payment thresholds, etc.
8. Once you're happy with the settings, go ahead and start all the pool daemons, commands follow.

```shell
cd ~/nodejs-pool/
pm2 start init.js --name=blockManager --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z"  -- --module=blockManager
pm2 start init.js --name=worker --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=worker
pm2 start init.js --name=pool_stats --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool_stats
pm2 start init.js --name=payments --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" --no-autorestart -- --module=payments
pm2 start init.js --name=remoteShare --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=remoteShare
pm2 start init.js --name=longRunner --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=longRunner
pm2 start init.js --name=pool --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
pm2 start init.js --name=api --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=api
pm2 restart api
```

Install Script:
```bash
curl -L https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/deploy.bash | bash
```

Assumptions for the installer
-----------------------------
The installer assumes that you will be running a single-node instance and using a clean Ubuntu 16.04 server install.  The following system defaults are set:
* MySQL Username: pool
* MySQL Password: 98erhfiuehw987fh23d
* MySQL Host: 127.0.0.1
* MySQL root access is only permitted as the root user, the password is in `/root/.my.cnf`
* SSL Certificate is generated, self-signed, but is valid for Claymore Miners.
* The server installs and deploys Caddy as it's choice of web server!

The following raw binaries **MUST BE AVAILABLE FOR IT TO BOOTSTRAP**:
* sudo

I've confirmed that the default server 16.04 installation has these requirements.

The pool comes pre-configured with values for Monero (XMR), these may need to be changed depending on the exact requirements of your coin.  Other coins will likely be added down the road, and most likely will have configuration.sqls provided to overwrite the base configurations for their needs, but can be configured within the frontend as well.

The pool ALSO applies a series of patches:  Fluffy Blocks, Additional Open P2P Connections, 128 Txn Bug Fix.  If you don't like these, replace the auto-installed monerod fixes!

Wallet Setup
------------
The pool is designed to have a dual-wallet design, one which is a fee wallet, one which is the live pool wallet.  The fee wallet is the default target for all fees owed to the pool owner.  PM2 can also manage your wallet daemon, and that is the suggested run state.

1. Generate your wallets using `/usr/local/src/monero/build/release/bin/monero-wallet-cli`
2. Make sure to save your regeneration stuff!
3. For the pool wallet, store the password in a file, the suggestion is `~/wallet_pass`
4. Change the mode of the file with chmod to 0400: `chmod 0400 ~/wallet_pass`
5. Start the wallet using PM2: `pm2 start /usr/local/src/monero/build/release/bin/monero-wallet-rpc -- --rpc-bind-port 18082 --password-file ~/wallet_pass --wallet-file <Your wallet name here> --disable-rpc-login --trusted-daemon`
6. If you don't use PM2, then throw the wallet into a screen and have fun.

Manual Setup
------------
Pretty similar to the above, you may wish to dig through a few other things for sanity sake, but the installer scripts should give you a good idea of what to expect from the ground up.

Manual SQL Configuration
------------------------
Until the full frontend is released, the following SQL information needs to be updated by hand in order to bring your pool online, in module/item format.  You can also edit the values in sample_config.sql, then import them into SQL directly via an update.
```
Critical/Must be done:
pool/address
pool/feeAddress
general/shareHost

Nice to have:
general/mailgunKey
general/mailgunURL
general/emailFrom

SQL import command: sudo mysql pool < ~/nodejs-pool/sample_config.sql (Adjust name/path as needed!)
```

The shareHost configuration is designed to be pointed at wherever the leafApi endpoint exists.  For moneroocean.stream, we use https://api.moneroocean.stream/leafApi.  If you're using the automated setup script, you can use: `http://<your IP>/leafApi`, as Caddy will proxy it.  If you're just using localhost and a local pool serv, http://127.0.0.1:8000/leafApi will do you quite nicely

Additional ports can be added as desired, samples can be found at the end of base.sql.  If you're not comfortable with the MySQL command line, I highly suggest MySQL Workbench or a similar piece of software (I use datagrip!).  Your root MySQL password can be found in `/root/.my.cnf`

Final Manual Steps
------------------
Until the main frontend is done, we suggest running the following SQL line:
```
DELETE FROM pool.users WHERE username = 'Administrator';
```
This will remove the administrator user until there's an easier way to change the password.  Alternatively, you can change the password to something not known by the public:
```
UPDATE pool.users SET email='your new password here' WHERE username='Administrator';
```
The email field is used as the default password field until the password is changed, at which point, it's hashed and dumped into the password field instead, and using the email field as a password is disabled.

You should take a look at the [wiki](https://github.com/MoneroOcean/nodejs-pool/wiki/Configuration-Details) for specific configuration settings in the system.

Pool Update Procedures
======================
If upgrading the pool, please do a git pull to get the latest code within the pool's directory.

Once complete, please `cd` into `sql_sync`, then run `node sql_sync.js`

This will update your pool with the latest config options with any defaults that the pools may set.

Pool Troubleshooting
====================

API stopped updating!
---------------------
This is likely due to LMDB's MDB_SIZE being hit, or due to LMDB locking up due to a reader staying open too long, possibly due to a software crash.
The first step is to run:
```
mdb_stat -fear ~/pool_db/
```
This should give you output like:
```
Environment Info
  Map address: (nil)
  Map size: 51539607552
  Page size: 4096
  Max pages: 12582912
  Number of pages used: 12582904
  Last transaction ID: 74988258
  Max readers: 512
  Number of readers used: 24
Reader Table Status
    pid     thread     txnid
     25763 7f4f0937b740 74988258
Freelist Status
  Tree depth: 3
  Branch pages: 135
  Leaf pages: 29917
  Overflow pages: 35
  Entries: 591284
  Free pages: 12234698
Status of Main DB
  Tree depth: 1
  Branch pages: 0
  Leaf pages: 1
  Overflow pages: 0
  Entries: 3
Status of blocks
  Tree depth: 1
  Branch pages: 0
  Leaf pages: 1
  Overflow pages: 0
  Entries: 23
Status of cache
  Tree depth: 3
  Branch pages: 16
  Leaf pages: 178
  Overflow pages: 2013
  Entries: 556
Status of shares
  Tree depth: 2
  Branch pages: 1
  Leaf pages: 31
  Overflow pages: 0
  Entries: 4379344
```
The important thing to verify here is that the "Number of pages used" value is less than the "Max Pages" value, and that there are "Free pages" under "Freelist Status".  If this is the case, them look at the "Reader Table Status" and look for the PID listed.  Run:
```shell
ps fuax | grep <THE PID FROM ABOVE>

ex:
ps fuax | grep 25763
```
If the output is not blank, then one of your node processes is reading, this is fine.  If there is no output given on one of them, then proceed forwards.

The second step is to run:
```shell
pm2 stop blockManager worker payments remoteShare longRunner api
pm2 start blockManager worker payments remoteShare longRunner api
```
This will restart all of your related daemons, and will clear any open reader connections, allowing LMDB to get back to a normal state.

If on the other hand, you have no "Free pages" and your Pages used is equal to the Max Pages, then you've run out of disk space for LMDB.  You need to verify the cleaner is working.  For reference, 4.3 million shares are stored within approximately 2-3 Gb of space, so if you're vastly exceeding this, then your cleaner (longRunner) is likely broken.


PPS Fee Thoughts
================
If you're considering PPS, I've spoken with [Fireice_UK](https://github.com/fireice-uk/) whom kindly did some math about what you're looking at in terms of requirements to run a PPS pool without it self-imploding under particular risk factors, based on the work found [here](https://arxiv.org/pdf/1112.4980.pdf)

```text
Also I calculated the amount of XMR needed to for a PPS pool to stay afloat. Perhaps you should put them up in the README to stop some spectacular clusterfucks :D:
For 1 in 1000000 chance that the pool will go bankrupt: 5% fee -> 1200 2% fee -> 3000
For 1 in 1000000000 chance: 5% fee -> 1800 2% fee -> 4500
```

The developers of the pool have not verified this, but based on usage on https://xmrpool.net/ this seems rather reasonable.  You should be wary if you're considering PPS and take you fees into account appropriately!

Installation/Configuration Assistance
=====================================
If you need help installing the pool from scratch, please have your servers ready, which would be Ubuntu 16.04 servers, blank and clean, DNS records pointed.  These need to be x86_64 boxes with AES-NI Available.

Installation assistance is 3 XMR, with a 1 XMR deposit, with remainder to be paid on completion.
Configuration assistance is 2 XMR with a 1 XMR deposit, and includes debugging your pool configurations, ensuring that everything is running, and tuning for your uses/needs.
altblockManager module source (that determines the most profitable coin to mine and trades them to main coin on exchanges, in particular
TradeOgre, Qryptos, Livecoin and Cryptopia integrations) price is 20 XMR.

SSH access with a sudo-enabled user will be needed, preferably the user that is slated to run the pool.

Assistance is not available for frontend customization at this time.

For assistance, please contact MoneroOcean at support@moneroocean.stream.

Developer Donations
===================
If you'd like to make a one time donation, the addresses are as follows:
* XMR - ```89TxfrUmqJJcb1V124WsUzA78Xa3UYHt7Bg8RGMhXVeZYPN8cE5CZEk58Y1m23ZMLHN7wYeJ9da5n5MXharEjrm41hSnWHL```
* AEON - ```WmsEg3RuUKCcEvFBtXcqRnGYfiqGJLP1FGBYiNMgrcdUjZ8iMcUn2tdcz59T89inWr9Vae4APBNf7Bg2DReFP5jr23SQqaDMT```
* ETN - ```etnkQMp3Hmsay2p7uxokuHRKANrMDNASwQjDUgFb5L2sDM3jqUkYQPKBkooQFHVWBzEaZVzfzrXoETX6RbMEvg4R4csxfRHLo1```
* SUMO - ```Sumoo1DGS7c9LEKZNipsiDEqRzaUB3ws7YHfUiiZpx9SQDhdYGEEbZjRET26ewuYEWAZ8uKrz6vpUZkEVY7mDCZyGnQhkLpxKmy```
* GRFT - ```GACadqdXj5eNLnyNxvQ56wcmsmVCFLkHQKgtaQXNEE5zjMDJkWcMVju2aYtxbTnZgBboWYmHovuiH1Ahm4g2N5a7LuMQrpT```
* MSR - ```5hnMXUKArLDRue5tWsNpbmGLsLQibt23MEsV3VGwY6MGStYwfTqHkff4BgvziprTitbcDYYpFXw2rEgXeipsABTtEmcmnCK```
* ITNS - ```iz53aMEaKJ25zB8xku3FQK5VVvmu2v6DENnbGHRmn659jfrGWBH1beqAzEVYaKhTyMZcxLJAdaCW3Kof1DwTiTbp1DSqLae3e```
* WOW - ```Wo3yjV8UkwvbJDCB1Jy7vvXv3aaQu3K8YMG6tbY3Jo2KApfyf5RByZiBXy95bzmoR3AvPgNq6rHzm98LoHTkzjiA2dY7sqQMJ```
* XMV - ```XvyVfpAYp3zSuvdtoHgnDzMUf7GAeiumeUgVC7RTq6SfgtzGEzy4dUgfEEfD5adk1kN4dfVZdT3zZdgSD2xmVBs627Vwt2C3Ey```
* RYO - ```RYoLsi22qnoKYhnv1DwHBXcGe9QK6P9zmekwQnHdUAak7adFBK4i32wFTszivQ9wEPeugbXr2UD7tMd6ogf1dbHh76G5UszE7k1```
* XTL - ```Se3Qr5s83AxjCtYrkkqg6QXJagCVi8dELbHb5Cnemw4rMk3xZzEX3kQfWrbTZPpdAJSP3enA6ri3DcvdkERkGKE518vyPQTyi```
* XHV - ```hvxyEmtbqs5TEk9U2tCxyfGx2dyGD1g8EBspdr3GivhPchkvnMHtpCR2fGLc5oEY42UGHVBMBANPge5QJ7BDXSMu1Ga2KFspQR```
* TUBE - ```TubedBNkgkTbd2CBmLQSwW58baJNghD9xdmctiRXjrW3dE8xpUcoXimY4J5UMrnUBrUDmfQrbxRYRX9s5tQe7pWYNF2QiAdH1Fh```
* LOKI - ```L6XqN6JDedz5Ub8KxpMYRCUoQCuyEA8EegEmeQsdP5FCNuXJavcrxPvLhpqY6emphGTYVrmAUVECsE9drafvY2hXUTJz6rW```
* TRTL - ```TRTLv2x2bac17cngo1r2wt3CaxN8ckoWHe2TX7dc8zW8Fc9dpmxAvhVX4u4zPjpv9WeALm2koBLF36REVvsLmeufZZ1Yx6uWkYG```
* XTNC - ```XtazhSxz1bbJLpT2JuiD2UWFUJYSFty5SVWuF6sy2w9v8pn69smkUxkTVCQc8NKCd6CBMNDGzgdPRYBKaHdbgZ5SNptVH1yPCTQ```
* IRD - ```ir3DHyB8Ub1aAHEewMeUxQ7b7tQdWa7VL8M5oXDPohS3Me4nhwvALXM4mym2kWg9VsceT75dm6XWiWF1K4zu8RVQ1HJD8Z3R9```
* ARQ - ```ar4Ha6ZQCkKRhkKQLfexv7VZQM2MhUmMmU9hmzswCPK4T3o2rbPKZM1GxEoYg4AFQsh57PsEets7sbpU958FAvxo2RkkTQ1gE```
* XWP - ```fh4MCJrakhWGoS6Meqp6UxGE1GNfAjKaRdPjW36rTffDiqvEq2HWEKZhrbYRw7XJb3CXxkjL3tcYGTT39m5qgjvk1ap4bVu1R```
* XEQ - ```Tvzp9tTmdGP9X8hCEw1Qzn18divQajJYTjR5HuUzHPKyLK5fzRt2X73FKBDzcnHMDJKdgsPhUDVrKHVcDJQVmLBg33NbkdjQb```
* XTA - ```ipN5cNhm7RXAGACP4ZXki4afT3iJ1A6Ka5U4cswE6fBPDcv8JpivurBj3vu1bXwPyb8KZEGsFUYMmToFG4N9V9G72X4WpAQ8L```
* DERO - ```dERokvcrnuWH1ai1QmZQc9cgxrLwE3rX3TbhdrnLmi3BVZmf197qd5FaFqmPMp5dZ3igXfVQwUUMgTSjpVKDtUeb6DT2xp64XJ```
* CCX - ```ccx7dmnBBoRPuVcpKJSAVZKdSDo9rc7HVijFbhG34jsXL3qiqfRwu7A5ecem44s2rngDd8y8N4QnYK6WR3mXAcAZ5iXun9BQBx```
* BTC - ```3BzvMuLStA388kYZ9nudfm8L22937dSPS3```
* BCH - ```qrhww48p5s6zw9twhc7cujgwp7vym2k4vutem6f92p```
* ETH - ```0xCF8BABC074C487Ae17F9Ce0394eab492E6A35658```
* LTC - ```MCkjQo99VzoeZQ1piDzLDb4uqNSDRZpx55```

Credits
=======

[Zone117x](https://github.com/zone117x) - Original [node-cryptonote-pool](https://github.com/zone117x/node-cryptonote-pool) from which, the stratum implementation has been borrowed.

[Snipa](https://github.com/Snipa22) - Original [nodejs-pool](https://github.com/Snipa22/nodejs-pool) from which, the original implementation has been borrowed.

[Mesh00](https://github.com/mesh0000) - Frontend build in Angular JS [XMRPoolUI](https://github.com/mesh0000/poolui)

[Wolf0](https://github.com/wolf9466/)/[OhGodAGirl](https://github.com/ohgodagirl) - Rebuild of node-multi-hashing with AES-NI [node-multi-hashing](https://github.com/Snipa22/node-multi-hashing-aesni)
