CREATE DATABASE pool;
GRANT ALL ON pool.* TO pool@`127.0.0.1` IDENTIFIED BY '98erhfiuehw987fh23d';
GRANT ALL ON pool.* TO pool@localhost IDENTIFIED BY '98erhfiuehw987fh23d';
FLUSH PRIVILEGES;
USE pool;
ALTER DATABASE pool DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;
CREATE TABLE `balance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `last_edited` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `payment_address` varchar(128) DEFAULT NULL,
  `payment_id` varchar(128) DEFAULT NULL,
  `pool_type` varchar(64) DEFAULT NULL,
  `bitcoin` tinyint(1) DEFAULT NULL,
  `amount` bigint(26) DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `balance_id_uindex` (`id`),
  UNIQUE KEY `balance_payment_address_pool_type_bitcoin_payment_id_uindex` (`payment_address`,`pool_type`,`bitcoin`,`payment_id`),
  KEY `balance_payment_address_payment_id_index` (`payment_address`,`payment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `bans` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `ip_address` varchar(40) DEFAULT NULL,
  `mining_address` varchar(200) DEFAULT NULL,
  `reason` varchar(200) DEFAULT NULL,
  `active` tinyint(1) DEFAULT '1',
  `ins_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `bans_id_uindex` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `notifications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `mining_address` varchar(200) DEFAULT NULL,
  `message` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notifications_id_uindex` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `block_log` (
  `id` int(11) NOT NULL COMMENT 'Block Height',
  `orphan` tinyint(1) DEFAULT '1',
  `hex` varchar(128) NOT NULL,
  `find_time` timestamp NULL DEFAULT NULL,
  `reward` bigint(20) DEFAULT NULL,
  `difficulty` bigint(20) DEFAULT NULL,
  `major_version` int(11) DEFAULT NULL,
  `minor_version` int(11) DEFAULT NULL,
  PRIMARY KEY (`hex`),
  UNIQUE KEY `block_log_hex_uindex` (`hex`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `config` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `module` varchar(32) DEFAULT NULL,
  `item` varchar(32) DEFAULT NULL,
  `item_value` mediumtext,
  `item_type` varchar(64) DEFAULT NULL,
  `Item_desc` varchar(512) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `config_id_uindex` (`id`),
  UNIQUE KEY `config_module_item_uindex` (`module`,`item`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `payments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `unlocked_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `paid_time` timestamp NOT NULL DEFAULT '1970-01-01 00:00:01',
  `pool_type` varchar(64) DEFAULT NULL,
  `payment_address` varchar(125) DEFAULT NULL,
  `transaction_id` int(11) DEFAULT NULL COMMENT 'Transaction ID in the transactions table',
  `bitcoin` tinyint(1) DEFAULT '0',
  `amount` bigint(20) DEFAULT NULL,
  `block_id` int(11) DEFAULT NULL,
  `payment_id` varchar(128) DEFAULT NULL,
  `transfer_fee` bigint(20) DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `payments_id_uindex` (`id`),
  KEY `payments_transactions_id_fk` (`transaction_id`),
  KEY `payments_payment_address_payment_id_index` (`payment_address`,`payment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `pools` (
  `id` int(11) NOT NULL,
  `ip` varchar(72) NOT NULL,
  `last_checkin` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `active` tinyint(1) NOT NULL,
  `blockID` int(11) DEFAULT NULL,
  `blockIDTime` timestamp NULL DEFAULT NULL,
  `hostname` varchar(128) DEFAULT NULL,
  `port` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pools_id_uindex` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `port_config` (
  `poolPort` int(11) NOT NULL,
  `difficulty` int(11) DEFAULT '1000',
  `portDesc` varchar(128) DEFAULT NULL,
  `portType` varchar(16) DEFAULT NULL,
  `hidden` tinyint(1) DEFAULT '0',
  `ssl` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`poolPort`),
  UNIQUE KEY `port_config_poolPort_uindex` (`poolPort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `ports` (
  `pool_id` int(11) DEFAULT NULL,
  `network_port` int(11) DEFAULT NULL,
  `starting_diff` int(11) DEFAULT NULL,
  `port_type` varchar(64) DEFAULT NULL,
  `description` varchar(256) DEFAULT NULL,
  `hidden` tinyint(1) DEFAULT '0',
  `ip_address` varchar(256) DEFAULT NULL,
  `lastSeen` timestamp NULL DEFAULT NULL,
  `miners` int(11) DEFAULT NULL,
  `ssl_port` tinyint(1) DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `shapeshiftTxn` (
  `id` varchar(64) NOT NULL,
  `address` varchar(128) DEFAULT NULL,
  `paymentID` varchar(128) DEFAULT NULL,
  `depositType` varchar(16) DEFAULT NULL,
  `withdrawl` varchar(128) DEFAULT NULL,
  `withdrawlType` varchar(16) DEFAULT NULL,
  `returnAddress` varchar(128) DEFAULT NULL,
  `returnAddressType` varchar(16) DEFAULT NULL,
  `txnStatus` varchar(64) DEFAULT NULL,
  `amountDeposited` bigint(26) DEFAULT NULL,
  `amountSent` float DEFAULT NULL,
  `transactionHash` varchar(128) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `shapeshiftTxn_id_uindex` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `transactions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `bitcoin` tinyint(1) DEFAULT NULL,
  `address` varchar(128) DEFAULT NULL,
  `payment_id` varchar(128) DEFAULT NULL,
  `xmr_amt` bigint(26) DEFAULT NULL,
  `btc_amt` bigint(26) DEFAULT NULL,
  `transaction_hash` varchar(128) DEFAULT NULL,
  `submitted_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `mixin` int(11) DEFAULT NULL,
  `fees` bigint(26) DEFAULT NULL,
  `payees` int(11) DEFAULT NULL,
  `exchange_rate` bigint(26) DEFAULT NULL,
  `confirmed` tinyint(1) DEFAULT NULL,
  `confirmed_time` timestamp NULL DEFAULT NULL,
  `exchange_name` varchar(64) DEFAULT NULL,
  `exchange_txn_id` varchar(128) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `transactions_id_uindex` (`id`),
  KEY `transactions_shapeshiftTxn_id_fk` (`exchange_txn_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(256) NOT NULL,
  `pass` varchar(64) DEFAULT NULL,
  `email` varchar(256) DEFAULT NULL,
  `admin` tinyint(1) DEFAULT '0',
  `payout_threshold` bigint(16) DEFAULT '0',
  `enable_email` tinyint(1) DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_id_uindex` (`id`),
  UNIQUE KEY `users_username_uindex` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `xmrtoTxn` (
  `id` varchar(64) NOT NULL,
  `address` varchar(128) DEFAULT NULL,
  `paymentID` varchar(128) DEFAULT NULL,
  `depositType` varchar(16) DEFAULT NULL,
  `withdrawl` varchar(128) DEFAULT NULL,
  `withdrawlType` varchar(16) DEFAULT NULL,
  `returnAddress` varchar(128) DEFAULT NULL,
  `returnAddressType` varchar(16) DEFAULT NULL,
  `txnStatus` varchar(64) DEFAULT NULL,
  `amountDeposited` bigint(26) DEFAULT NULL,
  `amountSent` float DEFAULT NULL,
  `transactionHash` varchar(128) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `xmrtoTxn_id_uindex` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'minerTimeout', '900', 'int', 'Length of time before a miner is flagged inactive.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'banEnabled', 'true', 'bool', 'Enables/disabled banning of "bad" miners.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'banLength', '-15m', 'string', 'Ban duration except perma-bans');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'targetTime', '30', 'int', 'Time in seconds between share finds');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'trustThreshold', '30', 'int', 'Number of shares before miner trust can kick in.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'banPercent', '25', 'int', 'Percentage of shares that need to be invalid to be banned.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'banThreshold', '30', 'int', 'Number of shares before bans can begin');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'trustedMiners', 'true', 'bool', 'Enable the miner trust system');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'trustChange', '1', 'int', 'Change in the miner trust in percent');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'trustMin', '20', 'int', 'Minimum level of miner trust');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'trustPenalty', '30', 'int', 'Number of shares that must be successful to be trusted, reset to this value if trust share is broken');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'retargetTime', '60', 'int', 'Time between difficulty retargets');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'address', '127.0.0.1', 'string', 'Monero Daemon RPC IP');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'port', '18081', 'int', 'Monero Daemon RPC Port');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePort',     '18081', 'int', 'Main coin active daemon RPC port');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePortRYO',  '0', 'int', 'Ryo coin daemon RPC port or 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePortLOKI', '0', 'int', 'Loki coin daemon RPC port or 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePortTUBE', '0', 'int', 'BitTube coin daemon RPC port or 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePortXHV',  '0', 'int', 'Haven coin daemon RPC port or 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePortAEON', '0', 'int', 'Aeon coin daemon RPC port or 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePortMSR',  '0', 'int', 'Masari coin daemon RPC port or 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePortXTL',  '0', 'int', 'Stellite coin daemon RPC port or 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePortLTHN',  '0', 'int', 'Lethean coin daemon RPC port or 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePortGRFT',  '0', 'int', 'Graft coin daemon RPC port or 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'activePortTRTL',  '0', 'int', 'Turtle coin daemon RPC port or 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'coinHashFactorRYO',  '0', 'float', 'Ryo algo hash price factor relative to coinHashFactor');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'coinHashFactorLOKI', '0', 'float', 'Loki algo hash price factor relative to coinHashFactor');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'coinHashFactorTUBE', '0', 'float', 'BitTube algo hash price factor relative to coinHashFactor');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'coinHashFactorXHV',  '0', 'float', 'Haven algo hash price factor relative to coinHashFactor');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'coinHashFactorAEON', '0', 'float', 'Aeon algo hash price factor relative to coinHashFactor');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'coinHashFactorMSR',  '0', 'float', 'Masari algo hash price factor relative to coinHashFactor');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'coinHashFactorXTL',  '0', 'float', 'Stellite algo hash price factor relative to coinHashFactor');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'coinHashFactorLTHN',  '0', 'float', 'Lethean algo hash price factor relative to coinHashFactor');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'coinHashFactorGRFT',  '0', 'float', 'Graft algo hash price factor relative to coinHashFactor');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'coinHashFactorTRTL',  '0', 'float', 'Turtle algo hash price factor relative to coinHashFactor');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('daemon', 'enableAlgoSwitching', 'false', 'bool', 'Enable smart miners (need additional altblockManager module)');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('wallet', 'address', '127.0.0.1', 'string', 'Monero Daemon RPC Wallet IP');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('wallet', 'port', '18082', 'int', 'Monero Daemon RPC Wallet Port');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('rpc', 'https', 'false', 'bool', 'Enable RPC over SSL');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'maxDifficulty', '500000', 'int', 'Maximum difficulty for VarDiff');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'minDifficulty', '100', 'int', 'Minimum difficulty for VarDiff');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'varDiffVariance', '20', 'int', 'Percentage out of the target time that difficulty changes');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'varDiffMaxChange', '125', 'int', 'Percentage amount that the difficulty may change');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'btcFee', '1.5', 'float', 'Fee charged for auto withdrawl via BTC');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'ppsFee', '6.5', 'float', 'Fee charged for usage of the PPS pool');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'pplnsFee', '.6', 'float', 'Fee charged for the usage of the PPLNS pool');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'propFee', '.7', 'float', 'Fee charged for the usage of the proportial pool');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'soloFee', '.4', 'float', 'Fee charged for usage of the solo mining pool');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'exchangeMin', '5', 'float', 'Minimum XMR balance for payout to exchange/payment ID');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'walletMin', '.3', 'float', 'Minimum XMR balance for payout to personal wallet');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'devDonation', '3', 'float', 'Donation to XMR core development');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'poolDevDonation', '3', 'float', 'Donation to pool developer');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'denom', '.000001', 'float', 'Minimum balance that will be paid out to.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'blocksRequired', '60', 'int', 'Blocks required to validate a payout before it''s performed.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'sigDivisor', '1000000000000', 'int', 'Divisor for turning coin into human readable amounts ');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'feesForTXN', '10', 'int', 'Amount of XMR that is left from the fees to pay miner fees.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'maxTxnValue', '250', 'int', 'Maximum amount of XMR to send in a single transaction');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'shapeshiftPair', 'xmr_btc', 'string', 'Pair to use in all shapeshift lookups for auto BTC payout');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'coinCode', 'XMR', 'string', 'Coincode to be loaded up w/ the shapeshift getcoins argument.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'allowBitcoin', 'false', 'bool', 'Allow the pool to auto-payout to BTC via ShapeShift');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'exchangeRate', '0', 'float', 'Current exchange rate');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'bestExchange', 'xmrto', 'string', 'Current best exchange');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'mixIn', '6', 'int', 'Mixin count for coins that support such things.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'statsBufferLength', '480', 'int', 'Number of items to be cached in the stats buffers.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pps', 'enable', 'false', 'bool', 'Enable PPS or not');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pplns', 'shareMulti', '2', 'int', 'Multiply this times difficulty to set the N in PPLNS');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pplns', 'shareMultiLog', '3', 'int', 'How many times the difficulty of the current block do we keep in shares before clearing them out');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'blockCleaner', 'true', 'bool', 'Enable the deletion of blocks or not.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address', '', 'string', 'Address to mine to, this should be the wallet-rpc address.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_19734', '', 'string', 'Address to mine to for 19734 (SUMO) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_26968', '', 'string', 'Address to mine to for 26968 (ETN) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_18981', '', 'string', 'Address to mine to for 18981 (GRFT) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_38081', '', 'string', 'Address to mine to for 38081 (MSR) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_48782', '', 'string', 'Address to mine to for 48782 (ITNS) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_34568', '', 'string', 'Address to mine to for 34568 (WOW) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_19091', '', 'string', 'Address to mine to for 19091 (XMV) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_12211', '', 'string', 'Address to mine to for 12211 (RYO) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_11181', '', 'string', 'Address to mine to for 11181 (Aeon) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_17750', '', 'string', 'Address to mine to for 17750 (Haven) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_24182', '', 'string', 'Address to mine to for 24182 (BitTube) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_20189', '', 'string', 'Address to mine to for 20189 (Stellite) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_22023', '', 'string', 'Address to mine to for 22023 (Loki) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address_11898', '', 'string', 'Address to mine to for 11898 (Turtle) port.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'feeAddress', '', 'string', 'Address that pool fees are sent to.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'mailgunKey', '', 'string', 'MailGun API Key for notification');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'mailgunURL', '', 'string', 'MailGun URL for notifications');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'mailgunNoCert', 'false', 'bool', 'Disable certificate check for MailGun');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'emailFrom', '', 'string', 'From address for the notification emails');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'testnet', 'false', 'bool', 'Does this pool use testnet?');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pplns', 'enable', 'true', 'bool', 'Enable PPLNS on the pool.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('solo', 'enable', 'true', 'bool', 'Enable SOLO mining on the pool');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'feeSlewAmount', '.011', 'float', 'Amount to charge for the txn fee');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'feeSlewEnd', '4', 'float', 'Value at which txn fee amount drops to 0');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'rpcPasswordEnabled', 'false', 'bool', 'Does the wallet use a RPC password?');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'rpcPasswordPath', '', 'string', 'Path and file for the RPC password file location');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'maxPaymentTxns', '5', 'int', 'Maximum number of transactions in a single payment');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'shareHost', '', 'string', 'Host that receives share information');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('email', 'workerNotHashingBody', 'Your worker: %(worker)s has stopped submitting hashes at: %(timestamp)s UTC\n', 'string', 'Email sent to the miner when their worker stops hashing');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('email', 'workerNotHashingSubject', 'Status of your worker(s)', 'string', 'Subject of email sent to miner when worker stops hashing');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('email', 'workerStartHashingBody', 'Your worker: %(worker)s has started submitting hashes at: %(timestamp)s UTC\n', 'string', 'Email sent to the miner when their worker starts hashing');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('email', 'workerStartHashingSubject', 'Status of your worker(s)', 'string', 'Subject of email sent to miner when worker starts hashing');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'emailSig', 'NodeJS-Pool Administration Team', 'string', 'Signature line for the emails.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'timer', '120', 'int', 'Number of minutes between main payment daemon cycles');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'timerRetry', '25', 'int', 'Number of minutes between payment daemon retrying due to not enough funds');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'priority', '0', 'int', 'Payout priority setting. 0 = use default (4x fee); 1 = low prio (1x fee)');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'allowStuckPoolKill', 'false', 'bool', 'Allow to kill the pool in case of stuck block template');
INSERT INTO pool.users (username, pass, email, admin, payout_threshold) VALUES ('Administrator', null, 'Password123', 1, 0);
INSERT INTO pool.port_config (poolPort, difficulty, portDesc, portType, hidden, `ssl`) VALUES (3333, 1000, 'Low-End Hardware (Up to 30-40 h/s)', 'pplns', 0, 0);
INSERT INTO pool.port_config (poolPort, difficulty, portDesc, portType, hidden, `ssl`) VALUES (5555, 5000, 'Medium-Range Hardware (Up to 160 h/s)', 'pplns', 0, 0);
INSERT INTO pool.port_config (poolPort, difficulty, portDesc, portType, hidden, `ssl`) VALUES (7777, 10000, 'High-End Hardware (Anything else!)', 'pplns', 0, 0);
INSERT INTO pool.port_config (poolPort, difficulty, portDesc, portType, hidden, `ssl`) VALUES (9000, 20000, 'Claymore SSL', 'pplns', 0, 1);
