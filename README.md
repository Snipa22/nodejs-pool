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

Xmrpool.net (The refrence implementation) uses the following setup:  
* https://xmrpool.net is hosted on it's own server, as the main website is a static frontend
* https://api.xmrpool.net hosts api, remoteShare, longRunner, payments, blockManager, worker, as these must all be hosted with access to the same LMDB database.

Sample Caddyfile for API:
```text
https://api.xmrpool.net {
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
* 2 CPU Cores
* 60 Gb SSD-Backed Storage - If you're doing a multi-server install, the leaf nodes do not need this much storage.  They just need enough storage to hold the blockchain for your node.  The pool comes configured to use up to 24Gb of storage for LMDB.  Assuming you have the longRunner worker running, it should never get near this size, but be aware that it /can/ bloat readily if things error, so be ready for this!
* Notably, this happens to be approximately the size of a 4Gb linode instance, which is where the majority of automated deployment testing happened!

Pre-Deploy
----------
* If you're planning on using e-mail, you'll want to setup an account at https://mailgun.com (It's free for 10k e-mails/month!), so you can notify miners.  This also serves as the backend for password reset emails, along with other sorts of e-mails from the pool, including pool startup, pool Monerod daemon lags, etc so it's highly suggested!
* Pre-Generate the wallets, or don't, it's up to you!  You'll need the addresses after the install is complete, so I'd suggest making sure you have them available.  Information on suggested setups are found below.
* If you're going to be offering PPS, PLEASE make sure you load the pool wallet with XMR before you get too far along.  Your pool will trigger PPS payments on it's own, and fairly readily, so you need some float in there!
* Make a non-root user, and run the installer from there!

Deployment via Installer
------------------------

1. Add your user to `/etc/sudoers`, this must be done so the script can sudo up and do it's job.  We suggest passwordless sudo.  Suggested line: `<USER> ALL=(ALL) NOPASSWD:ALL`.  Our sample builds use: `pooldaemon ALL=(ALL) NOPASSWD:ALL`
2. Run the [deploy script](https://raw.githubusercontent.com/Snipa22/nodejs-pool/master/deployment/deploy.bash) as a **NON-ROOT USER**.  This is very important!  This script will install the pool to whatever user it's running under!  Also.  Go get a coffee, this sucker bootstraps the monero installation.
3. Once it's complete, change as `config.json` appropriate.  It is pre-loaded for a local install of everything, running on 127.0.0.1.  This will work perfectly fine if you're using a single node setup.  You will also want to run: source ~/.bashrc  This will activate NVM and get things working for the following pm2 steps.
4. You'll need to change the API end point for the frontend code in the `poolui/app/utils/services.js` -- This will usually be `http://<your server ip>/api` unless you tweak caddy!
5. Change the `db_storage_path` in `config.json` for your database directory to: `/home/<username>/pool_db/`  The directory's already been created during startup.  Or change as appropriate!  Just make sure your user has write permissions, then run: `pm2 restart api` to reload the API for usage  You'll also want to set `bind_ip` to the external IP of the pool server, and hostname to the resolvable hostname for the pool server. `pool_id` is mostly used for multi-server installations to provide unique identifiers in the backend.
6. Hop into the web interface (Should be at `http://<your server IP>/#/admin`), then login with `Administrator/Password123`, **MAKE SURE TO CHANGE THIS PASSWORD ONCE YOU LOGIN**. *<- This step is currently not active, we're waiting for the frontend to catch up!  Head down to the Manual SQL Configuration to take a look at what needs to be done by hand for now*.
7. From the admin panel, you can configure all of your pool's settings for addresses, payment thresholds, etc.
8. Once you're happy with the settings, go ahead and start all the pool daemons, commands follow.

```shell
pm2 start init.js --name=blockManager --log-date-format="YYYY-MM-DD HH:mm Z"  -- --module=blockManager
pm2 start init.js --name=worker --log-date-format="YYYY-MM-DD HH:mm Z" -- --module=worker
pm2 start init.js --name=payments --log-date-format="YYYY-MM-DD HH:mm Z" -- --module=payments
pm2 start init.js --name=remoteShare --log-date-format="YYYY-MM-DD HH:mm Z" -- --module=remoteShare
pm2 start init.js --name=longRunner --log-date-format="YYYY-MM-DD HH:mm Z" -- --module=longRunner
pm2 start init.js --name=pool --log-date-format="YYYY-MM-DD HH:mm Z" -- --module=pool
pm2 restart api
```

Install Script:
```bash
curl -L https://raw.githubusercontent.com/Snipa22/nodejs-pool/master/deployment/deploy.bash | bash
```

Assumptions for the installer
-----------------------------
The installer assumes that you will be running a single-node instance and using a clean Ubuntu 16.04 server install.  The following system defaults are set:
* MySQL Username: pool
* MySQL Password: 98erhfiuehw987fh23d
* MySQL Host: 127.0.0.1
* MySQL root access is only permitted as the root user, the password is in `/root/.my.cnf`
* SSL Certificate is generated, self-signed, but is valid for Claymore Miners.
* The server installs and deploys Caddy as it's choice of webserver!

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
5. Start the wallet using PM2: `pm2 start /usr/local/src/monero/build/release/bin/monero-wallet-rpc -- --rpc-bind-port 18082 --password-file ~/wallet_pass --wallet-file <Your wallet name here> --disable-rpc-login`
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

The shareHost configuration is designed to be pointed at wherever the leafApi endpoint exists.  For xmrpool.net, we use https://api.xmrpool.net/leafApi.  If you're using the automated setup script, you can use: `http://<your IP>/leafApi`, as Caddy will proxy it.  If you're just using localhost and a local pool serv, http://127.0.0.1:8000/leafApi will do you quite nicely

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

You should take a look at the [wiki](https://github.com/Snipa22/nodejs-pool/wiki/Configuration-Details) for specific configuration settings in the system.

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
If you're considering PPS, I've spoken with [Fireice_UK](https://github.com/fireice-uk/) whom kindly did some math about what you're looking at in terms of requiements to run a PPS pool without it self-impoloding under particular risk factors, based on the work found [here](https://arxiv.org/pdf/1112.4980.pdf)

```text
Also I calculated the amount of XMR needed to for a PPS pool to stay afloat. Perhaps you should put them up in the README to stop some spectacular clusterfucks :D:
For 1 in 1000000 chance that the pool will go bankrupt: 5% fee -> 1200 2% fee -> 3000
For 1 in 1000000000 chance: 5% fee -> 1800 2% fee -> 4500
```

The developers of the pool have not verified this, but based on our own usage on https://xmrpool.net/ this seems rather reasonable.  You should be wary if you're consdering PPS and take you fees into account appropriately!

Credits
=======

[Zone117x](https://github.com/zone117x) - Original [node-cryptonote-pool](https://github.com/zone117x/node-cryptonote-pool) from which, the stratum implementation has been borrowed.

[Mesh00](https://github.com/mesh0000) - Frontend build in Angular JS [XMRPoolUI](https://github.com/mesh0000/poolui)

[Wolf0](https://github.com/wolf9466/)/[OhGodAGirl](https://github.com/ohgodagirl) - Rebuild of node-multi-hashing with AES-NI [node-multi-hashing](https://github.com/Snipa22/node-multi-hashing-aesni)
