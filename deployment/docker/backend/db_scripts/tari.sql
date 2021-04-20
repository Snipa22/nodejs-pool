INSERT INTO pool.config (module, item, item_value, item_type, Item_desc)
VALUES ('wallet', 'grpcAddress', '127.0.0.1', 'string', 'IP address of the Wallet GRPC endpoint'),
       ('wallet', 'grpcPort', '18181', 'int', 'Port of the Wallet GRPC endpoint'),
       ('general', 'network', 'mainnet', 'string', 'Monero network (mainnet, stagenet, testnet)');

CREATE TABLE `pending_payouts`
(
    `id`              int(11)         NOT NULL AUTO_INCREMENT,
    `tx_id`           varchar(128)    NOT NULL,
    `user_id`         int(11)         NOT NULL,
    `balance_id`      int(11)         NOT NULL,
    `payment_address` varchar(128)    NOT NULL,
    `payment_id`      varchar(128)             DEFAULT NULL,
    `amount`          bigint unsigned NOT NULL DEFAULT 0,
    `status`          ENUM('pending', 'error', 'complete', 'cancelled') NOT NULL DEFAULT 'pending',
    `last_checked_at` timestamp,
    `created_at`      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `pending_payouts_tx_id_uindex` (`tx_id`),
    KEY        `pending_payouts_address_index` (`payment_address`),
    KEY        `pending_payouts_address_payment_id_index` (`payment_address`,`payment_id`),
    KEY        `pending_payouts_status_index` (`status`),
    FOREIGN KEY (`user_id`) REFERENCES users(`id`),
    FOREIGN KEY (`balance_id`) REFERENCES balance(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

ALTER TABLE `payments`
    ADD COLUMN `coin` VARCHAR(32) NOT NULL DEFAULT 'xmr';

ALTER TABLE `balance`
    ADD COLUMN `locked` SMALLINT(1) NOT NULL DEFAULT 0,
    CHANGE COLUMN `payment_address` `payment_address` VARCHAR(256),
    ADD COLUMN `coin` VARCHAR(32) NOT NULL;

ALTER TABLE `block_balance`
    CHANGE COLUMN `payment_address` `payment_address` VARCHAR(256),
    ADD COLUMN `coin` VARCHAR(32);

ALTER TABLE `block_balance`
    ADD KEY `block_balance_coin_index` (`coin`);

