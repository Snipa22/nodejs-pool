2/12/2017
---------
```sql
ALTER TABLE pool.config MODIFY item_value TEXT;
```

2/13/2017
---------
```sql
ALTER TABLE pool.payments ADD transfer_fee BIGINT(20) DEFAULT 0 NULL;
```

2/16/2017
---------
```sql
ALTER DATABASE pool DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.balance CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.bans CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.block_log CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.config CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.payments CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.pools CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.port_config CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.ports CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.shapeshiftTxn CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.transactions CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.users CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
ALTER TABLE pool.xmrtoTxn CONVERT TO CHARACTER SET utf8 COLLATE utf8_general_ci;
```

2/25/2017
---------
```sql
ALTER TABLE pool.users ADD enable_email BOOL DEFAULT true NULL;
```