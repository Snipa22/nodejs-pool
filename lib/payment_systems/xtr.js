"use strict";
const {sql, sleep, tryParseMergeMiningAddress, toHex} = require("../common");
const debug = require('debug')("payments/xtr");
const {support, config} = global;
const {Client: TariWalletGrpcClient, types} = require("@tari/wallet-grpc-client");

const db = {
    pendingPayouts: {
        insert({txId, userId, balanceId, paymentAddress, paymentId, amount, status}) {
            const insertSql = "INSERT INTO `pending_payouts` (`tx_id`, `user_id`, `balance_id`, `payment_address`, `payment_id`, `amount`, `status`) VALUES (?, ?, ?, ?, ?, ?, ?)";
            return sql.execute(insertSql, [txId, userId, balanceId, paymentAddress, paymentId, amount, status]);
        },

        fetchByStatus(status, limit = null, select = "*") {
            let sqlStr = `SELECT ${select} FROM pending_payouts WHERE status = ? ORDER BY last_checked_at ASC`;
            let params = [status];
            if (limit) {
                sqlStr += ' LIMIT ?'
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
                // 🐲 -- Please be careful not to introduce SQL injection here
                valueSql.push(`\`${k}\` = ${sql.escape(v, typeof v === 'string')}`);
            }
            let sqlStr = `UPDATE pending_payouts SET ${valueSql.join(",")} WHERE id = ?`;
            return sql.execute(sqlStr, [id]);
        }
    },

    users: {
        get(id) {
            return sql.fetchOne("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
        },

        getByUsername(username) {
            return sql.fetchOne("SELECT * FROM users WHERE username LIKE ? LIMIT 1", [`${username}%`]);
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
        updateCustomUnescaped(id, valuesSqlFrag, values) {
            return sql.execute(`UPDATE balance SET ${valuesSqlFrag} WHERE id = ?`, [...values, id]);
        }
    },

    transactions: {
        insert({address, amount, paymentId, transactionHash, mixIn, fees, payees, bitcoin}) {
            const insertSql = "INSERT INTO transactions " +
                "(address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees, bitcoin) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
            return sql.execute(insertSql, [address, paymentId, amount, transactionHash, mixIn, fees, payees || 0, bitcoin ? 1 : 0]);
        }
    },

    payments: {
        insert({
                   unlockedTime,
                   paidTime,
                   poolType,
                   paymentAddress,
                   transactionId,
                   bitcoin,
                   amount,
                   paymentId,
                   transferFee
               }) {
            const insertSql =
                "INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, bitcoin, amount, payment_id, transfer_fee)" +
                " VALUES (now(), now(), ?, ?, ?, ?, ?, ?, ?)";
            return sql.execute(insertSql, [unlockedTime, paidTime, poolType, paymentAddress, transactionId, bitcoin, amount, paymentId, transferFee]);
        }
    }
};

function haltAndCatchFire(shortMsg, message) {
    support.sendEmail(config.general.adminEmail, `[haltAndCatchFire] payouts: ${shortMsg}`, message);
    throw new Error(message);
}

async function fetchDuePayouts() {
    const balances = await db.balance.findWhere('amount >= ? AND locked = 0', [support.decimalToCoin(config.payout.walletMin)]);
    const pendingPayoutUsers = (await db.pendingPayouts.fetchByStatus('pending', null, "user_id")).map(p => p.user_id);
    const pendingPayouts = [];

    debug(`Found ${balances.length} balance(s) for payout`);
    debug(`${pendingPayoutUsers.length} payouts are currently pending`);

    for (const balance of balances) {
        const user = await db.users.getByUsername(balance.payment_address);
        if (!user) {
            console.warn(`Could not find matching user for balance ${balance.payment_address} during payout!`);
            haltAndCatchFire(
                `Expected user ${balance.payment_address} does not exist`,
                `Could not find matching user for balance ${balance.payment_address} (${balance.id}) during payout!`
            );
        }

        if (pendingPayoutUsers.includes(user.id)) {
            console.log(`Existing pending payment for ${user.username}. Skipping payment until the last pending payment clears.`);
            continue;
        }

        const payout = Payout.from_balance(balance);
        payout.setUser(user);

        if (user.payout_threshold > 0) {
            payout.setCustomPayoutThreshold(user.payout_threshold);
        }
        console.log(`Payout required to "${payout.username()}" (payout threshold: ${payout.payoutThreshold})`);

        // if (payout.isFees() && payout.address === config.payout.feeAddress && payout.amount >= ((support.decimalToCoin(config.payout.feesForTXN) + support.decimalToCoin(config.payout.exchangeMin)))) {
        //     debug("This is the fee address internal check for value");
        //     payout.setAmount(payout.amount - support.decimalToCoin(config.payout.feesForTXN));
        // } else if (payout.address === config.payout.feeAddress && payout.isFees()) {
        //     debug("Unable to pay fee address.");
        //     payout.setAmount(0);
        // }

        // const remainder = payout.amount % (config.payout.denom * config.general.sigDivisor);
        // if (remainder > 0) {
        //     payout.setAmount(payout.amount - remainder);
        // }

        if (payout.isWithinThreshold()) {
            if (payout.amount === 0) {
                debug(`Payment for ${payout.username} has a zero amount.`)
                continue;
            }

            pendingPayoutUsers.push(payout.user.id);
            if (payout.bitcoin) {
                console.log("[+] " + payout.balanceId + " as separate payment to bitcoin. Amount: " + support.coinToDecimal(payout.amount));
                // TODO: Support bitcoin payments in future?
                console.warn(`Bitcoin payment not supported. Payment to ${payout.address} skipped`);
                // payment.makeBitcoinPayment();
                continue;
            }

            // Collect the payments to be done
            console.log(`[++] ${payout.tariAddress()} miner to bulk payment. Amount: ${support.coinToDecimal(payout.amount)}`);
            pendingPayouts.push(payout);
        } else {
            console.log(`[+] Payout for user ${payout.tariAddress()} not completed because it falls below payout threshold (#{payout.payoutThreshold}`);
        }
    }

    return pendingPayouts;
}

function logError(defautlVal = undefined) {
    return err => {
        console.error(err);
        return defautlVal;
    };
}

async function executePayouts(payouts) {
    const client = connectTariWalletGrpc();

    const recipients = payouts.map(p => ({
        address: p.tariAddress(),
        amount: p.amount,
        fee_per_gram: p.feePerGram,
        // TODO: Custom message
        message: 'Pool payout'
    }));

    const {version} = await client.getVersion().catch(logError({}));
    console.log(`Transferring funds using wallet v${version}`);

    const {results} = await client.transfer({recipients}).catch(logError({}));
    if (!results) {
        throw new Error("GRPC transfer call failed");
    }
    // Process the results and update balances
    for (const result of results) {
        const payout = payouts.find((p) => p.tariAddress() === result.address);
        if (!payout) {
            throw new Error(`Wallet GRPC returned result for an address we didn't request! Address not found: ${result.tariAddress()}`)
        }
        if (result.is_success) {
            // #sqltransactionkthx
            // Insert a pending payout to be monitored
            await db.pendingPayouts.insert({
                txId: result.transaction_id,
                userId: payout.user.id,
                balanceId: payout.balanceId,
                paymentAddress: result.address,
                paymentId: payout.paymentId,
                amount: payout.amount,
                status: 'pending'
            });
            await db.balance.updateCustomUnescaped(payout.balanceId, 'locked = 1', []);
        } else {
            console.warn(`Failed to submit payout for ${payout.tariAddress()}: '${result.failure_message}'.`);
            console.warn('Payout will be retried in the next payout cycle.');
        }
    }
}

function Payout(balanceId, addr, amount, poolType, paymentId) {
    if (!addr) {
        throw new Error("Payout address cannot be null");
    }

    const payout = config.payout;

    const address = tryParseMergeMiningAddress(addr);

    this.balanceId = balanceId;
    this.amount = amount;
    this.paymentId = paymentId;
    this.poolType = poolType;
    this.payoutThreshold = payout.defaultPay;
    this.baseFee = support.decimalToCoin(payout.feeSlewAmount);
    this.feePerGram = config.coin.feePerGram || 20;
    // this.fee = null;

    this.username = () => (this.user) ? this.user.username : null;
    this.tariAddress = () => address.tari;
    this.moneroAddress = () => address.monero;
    // this.username = () => `${this.tariAddress()}${this.paymentId ? `.${this.paymentId}}` : ''}`

    // this.setAmount = (amount) => {
    //     this.amount = amount;
    // }
    //
    // this.isFees = () => this.poolType === "fees"

    this.setCustomPayoutThreshold = (threshold) => {
        this.payoutThreshold = threshold;
    };

    // this.fees = () => {
    //     if (!this.fee) {
    //         this.fee = this.calculateFees();
    //     }
    //     return this.fee;
    // }

    // this.calculateFees = () => {
    //     let fee = this.baseFee;
    //     if (this.amount > support.decimalToCoin(payout.walletMin) && this.amount <= support.decimalToCoin(payout.feeSlewEnd)) {
    //         const feeValue = this.baseFee / (support.decimalToCoin(payout.feeSlewEnd) - support.decimalToCoin(payout.walletMin));
    //         fee -= (this.amount - support.decimalToCoin(payout.walletMin)) * feeValue;
    //     }
    //     return Math.floor(fee);
    // };

    this.isWithinThreshold = () => this.amount >= this.payoutThreshold
    this.setUser = user => {
        this.user = user;
    }
}

Payout.from_balance = (balance) => {
    return new Payout(balance.id, balance.payment_address, balance.amount, balance.pool_type, balance.paymentID);
};

function connectTariWalletGrpc() {
    const address = `${global.config.wallet.grpcAddress}:${global.config.wallet.grpcPort}`;
    console.log(`Establishing GRPC connection to ${address}`);
    return TariWalletGrpcClient.connect(address);
}

function PendingPayoutMonitor(options) {
    let is_stopped = false;

    let tariWalletClient = null;
    const getTariWalletClient = () => {
        if (!tariWalletClient) {
            tariWalletClient = connectTariWalletGrpc();
        }
        return tariWalletClient;
    };

    this.processPayouts = async () => {
        const pendingPayouts = await db.pendingPayouts.fetchByStatus('pending', options.maxPendingQueryLimit);
        if (pendingPayouts.length === 0) {
            console.log(`No pending payouts to process. Sleeping for ${options.pollInterval / 1000}s...`);
            return;
        }
        debug(`${pendingPayouts.length} payout(s) are being processed`);

        const resp = await getTariWalletClient().getTransactionInfo({
            transaction_ids: pendingPayouts.map(p => p.tx_id)
        });

        if (resp.transactions.length !== pendingPayouts.length) {
            debug('resp.transactions.length !== pendingPayouts.length:', resp);
        }

        for (const transaction of resp.transactions) {
            let pendingPayout = pendingPayouts.find(p => p.tx_id === transaction.tx_id);
            if (!pendingPayout) {
                throw new Error(`Base node returned a transaction ID (${transaction.tx_id}) that was not requested`);
            }

            switch (transaction.status) {
                case 'TRANSACTION_STATUS_BROADCAST':
                case 'TRANSACTION_STATUS_COMPLETED':
                case 'TRANSACTION_STATUS_PENDING': {
                    console.log(`Transaction ${transaction.tx_id} is still pending/waiting to be mined`);
                    await db.pendingPayouts.update(pendingPayout.id, {last_checked_at: 'now()'});
                    break;
                }

                case 'TRANSACTION_STATUS_MINED': {
                    console.log(`Transaction ${transaction.tx_id} has been completed successfully!`);
                    let paymentId = await this.handleSuccessfulPayout(pendingPayout, transaction);
                    debug(`Setting pending payout status to complete (id = ${pendingPayout.id}), payment_id = ${paymentId}`);
                    await db.pendingPayouts.update(pendingPayout.id, {
                        status: 'complete',
                        payment_id: paymentId,
                        last_checked_at: 'now()',
                    });
                    break;
                }

                default: {
                    console.error(`Unexpected transaction status ${transaction.status} for transaction ${transaction.tx_id}`);
                    break;
                }
            }
        }
    };

    this.handleSuccessfulPayout = async (pendingPayout, transaction) => {
        console.log(`[*] Successful payment to ${pendingPayout.payment_address} of ${support.coinToDecimal(transaction.amount)} XMR with tx_hash ${transaction.tx_id}`);

        let result = await db.transactions.insert({
            address: pendingPayout.payment_address,
            paymentId: pendingPayout.payment_id,
            xmrAmt: pendingPayout.amount,
            fees: transaction.fee,
            mixIn: config.payout.mixIn,
            transactionHash: toHex(transaction.excess_sig),
            bitcoin: false,
        });

        if (+result.affectedRows !== 1) {
            pendingPayout.transactionId = 0;
            // TODO:
            // pendingPayout.manualPaymentShow();
            throw new Error(`Failed to insert transaction. No rows affected for payout ${pendingPayout.balanceId}, username = '${pendingPayout.tariAddress()}'`);
        }

        pendingPayout.transactionId = result.insertId;
        pendingPayout.tx_hash = transaction.transaction_hash;
        pendingPayout.tx_key = '';

        await db.balance.updateCustomUnescaped(pendingPayout.balance_id, 'amount = amount - ?, locked = 0', [pendingPayout.amount]);
        let {insertId: paymentId} = await db.payments.insert({
            poolType: pendingPayout.poolType,
            address: pendingPayout.address,
            transactionId: pendingPayout.transactionId,
            bitcoin: pendingPayout.bitcoin,
            amount: pendingPayout.amount - transaction.fee,
            paymentId: pendingPayout.paymentId,
            fee: transaction.fee
        });

        let user = await db.users.get(pendingPayout.user_id);
        if (!user) {
            console.warn(`Expected to find user ${pendingPayout.user_id} but did not`);
            return paymentId;
        }
        if (user.enable_email) {
            // // toAddress, subject, body
            // const emailData = {
            //     address: payout.tariAddress(),
            //     address2: payout.id,
            //     payment_amount: global.support.coinToDecimal(payout.amount - payout.fee),
            //     amount: global.support.coinToDecimal(payout.amount),
            //     fee: global.support.coinToDecimal(payout.fee),
            //     tx_hash: payout.tx_hash,
            //     tx_key: payout.tx_key
            // };

            support.sendEmail(user.email,
                `Your ${pendingPayout.amount} XTR payment was just performed`,
                `Your payment of ${pendingPayout.amount} XTR (with tx fee ${transaction.fee} XMR) to ${pendingPayout.address} wallet was just performed and total due was decreased by ${pendingPayout.amount} XMR.\n`,
                pendingPayout.address
                // TODO:
                // (payee.tx_hash && payee.tx_key ?
                //         `Your payment tx_hash (tx_id) is ${tx_hash} and tx_key is ${tx_key} (can be used to verify payment)\n" +
                //         "Here is link to verify that this payment was made: https://xmrchain.net/prove/%(tx_hash)s/%(address)s/%(tx_key)s\n" +
                //         "You can also check that in your command line (cli) wallet using \"check_tx_key %(tx_hash)s %(tx_key)s %(address)s\" command " +
                //         "(see https://getmonero.org/resources/user-guides/prove-payment.html for more details)\n"
                //         : ""
            );
        }

        return paymentId;

    };

    this.start = async (onError) => {
        while (true) {
            try {
                if (is_stopped) {
                    break;
                }
                await this.processPayouts();
                if (is_stopped) {
                    break;
                }
                debug("PendingPayoutMonitor sleeping...");
                await sleep(options.pollInterval);
            } catch (err) {
                if (!onError) {
                    return
                }
                if (!await onError(err)) {
                    return;
                }
            }
        }
    };

    this.stop = () => {
        is_stopped = true;
    }
}

PendingPayoutMonitor.new = (opts) => new PendingPayoutMonitor(opts);

async function main() {
    let pendingPayoutsMonitor = PendingPayoutMonitor.new({
        maxPendingQueryLimit: 100,
        pollInterval: 10 * 1000,
    });

    try {
        pendingPayoutsMonitor.start(async (err) => {
            console.error(`Pending payout monitor error: ${err}`);
            await sleep(5 * 1000);
            // true means "error handled, please resume operations",
            return true;
        }).then(() => {
            console.log("Pending payout monitor stopped");
        });

        while (true) {
            const payouts = await fetchDuePayouts();
            debug(`${payouts.length} pending payout(s) found.`);
            if (payouts.length > 0) {
                await executePayouts(payouts);
            }
            debug("sleeping...");
            await sleep(10 * 1000);
        }
    } catch (err) {
        pendingPayoutsMonitor.stop();
        throw err;
    }
}

main().catch(console.error);
