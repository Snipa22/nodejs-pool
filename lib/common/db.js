const sql = require('./sql');

module.exports = {
    config: {
        all() {
            return sql.fetchMany('SELECT * FROM config');
        },
    },
    pendingPayouts: {
        insert({ txId, userId, balanceId, paymentAddress, paymentId, amount, status }) {
            const insertSql =
                'INSERT INTO `pending_payouts` (`tx_id`, `user_id`, `balance_id`, `payment_address`, `payment_id`, `amount`, `status`) VALUES (?, ?, ?, ?, ?, ?, ?)';
            return sql.execute(insertSql, [txId, userId, balanceId, paymentAddress, paymentId, amount, status]);
        },

        delete(id) {
            const insertSql = 'DELETE FROM `pending_payouts` WHERE id = ? LIMIT 1';
            return sql.execute(insertSql, [id]);
        },

        fetchByStatus(status, limit = null, select = '*') {
            let sqlStr = `SELECT ${select} FROM pending_payouts WHERE status = ? ORDER BY last_checked_at ASC`;
            let params = [status];
            if (limit) {
                sqlStr += ' LIMIT ?';
                params.push(limit);
            }
            return sql.fetchMany(sqlStr, params);
        },

        update(id, values) {
            const valueSql = [];
            for (const [k, v] of Object.entries(values)) {
                if (k === 'last_checked_at' && v === 'now()') {
                    valueSql.push('`last_checked_at` = now()');
                    continue;
                }
                // 🐲 -- Please be careful not to introduce SQL injection here as the key is unprotected
                valueSql.push(`\`${k}\` = ${sql.escape(v, typeof v === 'string')}`);
            }
            let sqlStr = `UPDATE pending_payouts SET ${valueSql.join(',')} WHERE id = ?`;
            return sql.execute(sqlStr, [id]);
        },

        deleteOldEntries() {
            return sql.execute(
                `DELETE FROM pending_payouts WHERE (status = 'cancelled' OR status = 'complete') AND created_at < CURDATE() - INTERVAL 7 DAY`,
                [],
            );
        },
    },

    users: {
        get(id) {
            return sql.fetchOne('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
        },

        getByUsername(username) {
            return sql.fetchOne('SELECT * FROM users WHERE username LIKE ? LIMIT 1', [`${username}%`]);
        },
    },

    balance: {
        /**
         * Find all matching balance records
         *
         * SQL INJECTION: When using this function, ensure that whereClause does not contain any unescaped untrusted input.
         */
        findWhere(whereClause, values) {
            return sql.fetchMany(`SELECT * FROM balance WHERE ${whereClause}`, values);
        },

        /**
         * Update a balance at the matching id, given a valuesSqlFrag (e.g. 'amount = ?, foo = ?') and values.
         *
         * SQL INJECTION: When using this function, ensure that valuesSqlFrag does not contain any unescaped untrusted input.
         */
        updateCustom(id, valuesSqlFrag, values) {
            return sql.execute(`UPDATE balance SET ${valuesSqlFrag} WHERE id = ?`, [...values, id]);
        },

        /**
         * Lock the balance at the given ID
         *
         * @param id
         * @returns {Promise<*>}
         */
        lock(id) {
            return sql.execute(`UPDATE balance SET locked = 1 WHERE id = ?`, [id]);
        },

        /**
         * Unlock the balance at the given ID
         *
         * @param id
         * @returns {Promise<*>}
         */
        unlock(id) {
            return sql.execute(`UPDATE balance SET locked = 0 WHERE id = ?`, [id]);
        },
    },

    transactions: {
        insert({ address, amount, paymentId, transactionHash, mixIn, fees, payees, bitcoin }) {
            const insertSql =
                'INSERT INTO transactions ' +
                '(address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees, bitcoin) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
            return sql.execute(insertSql, [
                address,
                paymentId,
                amount,
                transactionHash,
                mixIn,
                fees,
                payees || 0,
                bitcoin ? 1 : 0,
            ]);
        },
    },

    payments: {
        insert({ poolType, paymentAddress, transactionId, bitcoin, amount, paymentId, transferFee, blockId, coin }) {
            const insertSql =
                'INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, bitcoin, amount, payment_id, transfer_fee, block_id, coin)' +
                ' VALUES (now(), now(), ?, ?, ?, ?, ?, ?, ?, ?, ?)';
            return sql.execute(insertSql, [
                poolType,
                paymentAddress,
                transactionId,
                bitcoin,
                amount,
                paymentId,
                transferFee,
                blockId,
                coin,
            ]);
        },
    },
};
