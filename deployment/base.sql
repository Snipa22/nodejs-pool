CREATE DATABASE pool;
GRANT ALL ON pool.* TO pool@`127.0.0.1` IDENTIFIED BY '98erhfiuehw987fh23d';
GRANT ALL ON pool.* TO pool@localhost IDENTIFIED BY '98erhfiuehw987fh23d';
FLUSH PRIVILEGES;
USE pool;
CREATE TABLE balance
(
    id INT(11) PRIMARY KEY NOT NULL AUTO_INCREMENT,
    last_edited TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    payment_address VARCHAR(128),
    payment_id VARCHAR(128) DEFAULT NULL,
    pool_type VARCHAR(64),
    bitcoin TINYINT(1),
    amount BIGINT(26) DEFAULT '0'
);
CREATE UNIQUE INDEX balance_id_uindex ON balance (id);
CREATE UNIQUE INDEX balance_payment_address_pool_type_bitcoin_payment_id_uindex ON balance (payment_address, pool_type, bitcoin, payment_id);
CREATE INDEX balance_payment_address_payment_id_index ON balance (payment_address, payment_id);
CREATE TABLE bans
(
    id INT(11) PRIMARY KEY NOT NULL AUTO_INCREMENT,
    ip_address VARCHAR(40),
    mining_address VARCHAR(200),
    active TINYINT(1) DEFAULT '1',
    ins_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX bans_id_uindex ON bans (id);
CREATE TABLE block_log
(
    id INT(11) NOT NULL COMMENT 'Block Height',
    orphan TINYINT(1) DEFAULT '1',
    hex VARCHAR(128) PRIMARY KEY NOT NULL,
    find_time TIMESTAMP,
    reward BIGINT(20),
    difficulty BIGINT(20),
    major_version INT(11),
    minor_version INT(11)
);
CREATE UNIQUE INDEX block_log_hex_uindex ON block_log (hex);
CREATE TABLE config
(
    id INT(11) PRIMARY KEY NOT NULL AUTO_INCREMENT,
    module VARCHAR(32),
    item VARCHAR(32),
    item_value TEXT,
    item_type VARCHAR(64),
    Item_desc VARCHAR(512)
);
CREATE UNIQUE INDEX config_id_uindex ON config (id);
CREATE UNIQUE INDEX config_module_item_uindex ON config (module, item);
CREATE TABLE payments
(
    id INT(11) PRIMARY KEY NOT NULL AUTO_INCREMENT,
    unlocked_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    paid_time TIMESTAMP DEFAULT '1970-01-01 00:00:01' NOT NULL,
    pool_type VARCHAR(64),
    payment_address VARCHAR(125),
    transaction_id INT(11) COMMENT 'Transaction ID in the transactions table',
    bitcoin TINYINT(1) DEFAULT '0',
    amount BIGINT(20),
    block_id INT(11),
    payment_id VARCHAR(128)
);
CREATE UNIQUE INDEX payments_id_uindex ON payments (id);
CREATE INDEX payments_transactions_id_fk ON payments (transaction_id);
CREATE INDEX payments_payment_address_payment_id_index ON payments (payment_address, payment_id);
CREATE TABLE pools
(
    id INT(11) PRIMARY KEY NOT NULL,
    ip VARCHAR(72) NOT NULL,
    last_checkin TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    active TINYINT(1) NOT NULL,
    blockID INT(11),
    blockIDTime TIMESTAMP DEFAULT '1970-01-01 00:00:01',
    hostname VARCHAR(128)
);
CREATE UNIQUE INDEX pools_id_uindex ON pools (id);
CREATE TABLE ports
(
    pool_id INT(11),
    network_port INT(11),
    starting_diff INT(11),
    port_type VARCHAR(64),
    description VARCHAR(256),
    hidden TINYINT(1) DEFAULT '0',
    ip_address VARCHAR(256),
    lastSeen TIMESTAMP DEFAULT '1970-01-01 00:00:01',
    miners INT(11),
    ssl_port TINYINT(1) DEFAULT '0'
);
CREATE TABLE shapeshiftTxn
(
    id VARCHAR(64) PRIMARY KEY NOT NULL,
    address VARCHAR(128),
    paymentID VARCHAR(128),
    depositType VARCHAR(16),
    withdrawl VARCHAR(128),
    withdrawlType VARCHAR(16),
    returnAddress VARCHAR(128),
    returnAddressType VARCHAR(16),
    txnStatus VARCHAR(64),
    amountDeposited BIGINT(26),
    amountSent FLOAT,
    transactionHash VARCHAR(128)
);
CREATE UNIQUE INDEX shapeshiftTxn_id_uindex ON shapeshiftTxn (id);
CREATE TABLE transactions
(
    id INT(11) PRIMARY KEY NOT NULL AUTO_INCREMENT,
    bitcoin TINYINT(1),
    address VARCHAR(128),
    payment_id VARCHAR(128),
    xmr_amt BIGINT(26),
    btc_amt BIGINT(26),
    transaction_hash VARCHAR(128),
    submitted_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    mixin INT(11),
    fees BIGINT(26),
    payees INT(11),
    exchange_rate BIGINT(26),
    confirmed TINYINT(1),
    confirmed_time TIMESTAMP DEFAULT '1970-01-01 00:00:01',
    exchange_name VARCHAR(64),
    exchange_txn_id VARCHAR(128)
);
CREATE UNIQUE INDEX transactions_id_uindex ON transactions (id);
CREATE INDEX transactions_shapeshiftTxn_id_fk ON transactions (exchange_txn_id);
CREATE TABLE users
(
    id INT(11) PRIMARY KEY NOT NULL AUTO_INCREMENT,
    username VARCHAR(256) NOT NULL,
    pass VARCHAR(64),
    email VARCHAR(256),
    admin TINYINT(1) DEFAULT '0',
    payout_threshold BIGINT(16) DEFAULT '0'
);
CREATE UNIQUE INDEX users_id_uindex ON users (id);
CREATE UNIQUE INDEX users_username_uindex ON users (username);
CREATE TABLE xmrtoTxn
(
    id VARCHAR(64) PRIMARY KEY NOT NULL,
    address VARCHAR(128),
    paymentID VARCHAR(128),
    depositType VARCHAR(16),
    withdrawl VARCHAR(128),
    withdrawlType VARCHAR(16),
    returnAddress VARCHAR(128),
    returnAddressType VARCHAR(16),
    txnStatus VARCHAR(64),
    amountDeposited BIGINT(26),
    amountSent FLOAT,
    transactionHash VARCHAR(128)
);
CREATE UNIQUE INDEX xmrtoTxn_id_uindex ON xmrtoTxn (id);
CREATE TABLE port_config
(
    poolPort INT(11) PRIMARY KEY NOT NULL,
    difficulty INT(11) DEFAULT '1000',
    portDesc VARCHAR(128),
    portType VARCHAR(16),
    hidden TINYINT(1) DEFAULT '0',
    `ssl` TINYINT(1) DEFAULT '0'
);
CREATE UNIQUE INDEX port_config_poolPort_uindex ON port_config (poolPort);

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
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'mixIn', '4', 'int', 'Mixin count for coins that support such things.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'statsBufferLength', '480', 'int', 'Number of items to be cached in the stats buffers.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pps', 'enable', 'false', 'bool', 'Enable PPS or not');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pplns', 'shareMulti', '2', 'int', 'Multiply this times difficulty to set the N in PPLNS');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pplns', 'shareMultiLog', '3', 'int', 'How many times the difficulty of the current block do we keep in shares before clearing them out');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'blockCleaner', 'true', 'bool', 'Enable the deletion of blocks or not.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('pool', 'address', '', 'string', 'Address to mine to, this should be the wallet-rpc address.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('payout', 'feeAddress', '', 'string', 'Address that pool fees are sent to.');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'mailgunKey', '', 'string', 'MailGun API Key for notification');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'mailgunURL', '', 'string', 'MailGun URL for notifications');
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
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('email', 'workerNotHashingBody', 'Hello,\n\nYour worker: %(worker)s has stopped submitting hashes at: %(timestamp)s UTC\n\nThank you,\n%(poolEmailSig)s', 'string', 'Email sent to the miner when their worker stops hashing');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('email', 'workerNotHashingSubject', 'Worker %(worker)s stopped hashing', 'string', 'Subject of email sent to miner when worker stops hashing');
INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('general', 'emailSig', 'NodeJS-Pool Administration Team', 'string', 'Signature line for the emails.');
INSERT INTO pool.users (username, pass, email, admin, payout_threshold) VALUES ('Administrator', null, 'Password123', 1, 0);
INSERT INTO pool.port_config (poolPort, difficulty, portDesc, portType, hidden, `ssl`) VALUES (3333, 1000, 'Low-End Hardware (Up to 30-40 h/s)', 'pplns', 0, 0);
INSERT INTO pool.port_config (poolPort, difficulty, portDesc, portType, hidden, `ssl`) VALUES (5555, 5000, 'Medium-Range Hardware (Up to 160 h/s)', 'pplns', 0, 0);
INSERT INTO pool.port_config (poolPort, difficulty, portDesc, portType, hidden, `ssl`) VALUES (7777, 10000, 'High-End Hardware (Anything else!)', 'pplns', 0, 0);
INSERT INTO pool.port_config (poolPort, difficulty, portDesc, portType, hidden, `ssl`) VALUES (9000, 20000, 'Claymore SSL', 'pplns', 0, 1);