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

1. Add your user to /etc/sudoers, this must be done so the script can sudo up and do it's job.  We suggest passwordless sudo.  Suggested line: \<USER\> ALL=(ALL) NOPASSWD:ALL.  Our sample builds use: pooldaemon ALL=(ALL) NOPASSWD:ALL
2. Run the deploy script as a NON-ROOT USER.  This is very important!  This script will install the pool to whatever user it's running under!  Also.  Go get a coffee, this sucker bootstraps the monero installation
3. Once it's complete, copy config_example.json to config.json and change as appropriate.  It is pre-loaded for a local install of everything, running on 127.0.0.1.  This will work perfectly fine if you're using a single node setup.
4. You'll need to change the API end point for the frontend code in the xmrpoolui folder, under app/utils/services.js -- This will usually be http://\<your server ip\>/api unless you tweak caddy!
5. Change the path in config.json for your database directory to: /home/\<username\>/pool_db/  The directory's already been created during startup.  Or change as appropriate!  Just make sure your user has write permissions, then run: pm2 restart api to reload the API for usage
6. Hop into the web interface (Should be at http://\<your server IP\>/#/admin), then login with Administrator/Password123, MAKE SURE TO CHANGE THIS PASSWORD ONCE YOU LOGIN.
7. From the admin panel, you can configure all of your pool's settings for addresses, payment thresholds, etc.
8. Once you're happy with the settings, go ahead and start all the pool daemons, commands follow.

```bash
pm2 start init.js --name=blockManager -- --module=blockManager
pm2 start init.js --name=worker -- --module=worker
pm2 start init.js --name=payments -- --module=payments
pm2 start init.js --name=remoteShare -- --module=remoteShare
pm2 start init.js --name=longRunner -- --module=longRunner
pm2 start init.js --name=pool -- --module=pool
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
* MySQL root access is only permitted as the root user, the password is in /root/.my.cnf
* SSL Certificate is generated, self-signed, but is valid for Claymore Miners.
* The server installs and deploys Caddy as it's choice of webserver!

The following raw binaries MUST BE AVAILABLE FOR IT TO BOOTSTRAP:
* sudo

I've confirmed that the default server 16.04 installation has these requirements.

The pool comes pre-configured with values for Monero (XMR), these may need to be changed depending on the exact requirements of your coin.  Other coins will likely be added down the road, and most likely will have configuration.sqls provided to overwrite the base configurations for their needs, but can be configured within the frontend as well.

The pool ALSO applies a series of patches:  Fluffy Blocks, Additional Open P2P Connections, 128 Txn Bug Fix.  If you don't like these, replace the auto-installed monerod fixes!

Wallet Setup
------------
The pool is designed to have a dual-wallet design, one which is a fee wallet, one which is the live pool wallet.  The fee wallet is the default target for all fees owed to the pool owner.  PM2 can also manage your wallet daemon, and that is the suggested run state.

1. Generate your wallets using /usr/local/src/monero/build/release/bin/monero-wallet-cli
2. Make sure to save your regeneration stuff!
3. For the pool wallet, store the password in a file, the suggestion is ~/wallet_pass
4. Change the mode of the file with chmod to 0400: chmod 0400 ~/wallet_pass
5. Start the wallet using PM2: pm2 start /usr/local/src/monero/build/release/bin/monero-wallet-rpc -- --rpc-bind-port 18082 --password-file ~/wallet_pass --wallet-file \<Your wallet name here\>
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

Additional ports can be added as desired, samples can be found at the end of base.sql.  If you're not comfortable with the MySQL command line, I highly suggest MySQL Workbench or a similar piece of software (I use datagrip!).  Your root MySQL password can be found in /root/.my.cnf

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
```
ps fuax | grep <THE PID FROM ABOVE>

ex:
ps fuax | grep 25763
```
If the output is not blank, then one of your node processes is reading, this is fine.  If there is no output given on one of them, then proceed forwards.

The second step is to run:
```
pm2 stop blockManager worker payments remoteShare longRunner api
pm2 start blockManager worker payments remoteShare longRunner api
```
This will restart all of your related daemons, and will clear any open reader connections, allowing LMDB to get back to a normal state.

If on the other hand, you have no "Free pages" and your Pages used is equal to the Max Pages, then you've run out of disk space for LMDB.  You need to verify the cleaner is working.  For reference, 4.3 million shares are stored within approximately 2-3 Gb of space, so if you're vastly exceeding this, then your cleaner (longRunner) is likely broken.


Credits
=======

[Zone117x](https://github.com/zone117x) - Original [node-cryptonote-pool](https://github.com/zone117x/node-cryptonote-pool) from which, the stratum implementation has been borrowed.

[Mesh00](https://github.com/hackfanatic) - Frontend build in Angular JS [XMRPoolUI](https://github.com/hackfanatic/xmrpoolui)

[Wolf0](https://github.com/wolf9466/)/[OhGodAGirl](https://github.com/ohgodagirl) - Rebuild of node-multi-hashing with AES-NI [node-multi-hashing](https://github.com/Snipa22/node-multi-hashing-aesni)