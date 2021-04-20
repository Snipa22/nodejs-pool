'use strict';
const { sleep, aux, toHex, db } = require('../common');
const debug = require('debug')('payments');
const { support, config } = global;
const { Client: TariWalletGrpcClient, types } = require('@tari/wallet-grpc-client');

function haltAndCatchFire(shortMsg, message) {
    support.sendEmail(config.general.adminEmail, `[haltAndCatchFire] payouts: ${shortMsg}`, message);
    throw new Error(message);
}

async function fetchDuePayouts(coin) {
    const balances = await db.balance.findWhere('amount >= ? AND locked = 0 AND coin = ?', [
        support.decimalToCoin(config.payout.walletMin, coin),
        coin,
    ]);
    const pendingPayoutUsers = (await db.pendingPayouts.fetchByStatus('pending', null, 'user_id')).map(
        (p) => p.user_id,
    );
    const pendingPayouts = [];

    debug(`Found ${balances.length} balance(s) for payout`);
    debug(`${pendingPayoutUsers.length} payout(s) are in progress`);

    for (const balance of balances) {
        const user = await db.users.getByUsername(balance.payment_address);
        if (!user) {
            console.warn(`Could not find matching user for balance ${balance.payment_address} during payout!`);
            haltAndCatchFire(
                `Expected user ${balance.payment_address} does not exist`,
                `Could not find matching user for balance ${balance.payment_address} (${balance.id}) during payout!`,
            );
        }

        if (pendingPayoutUsers.includes(user.id)) {
            console.log(
                `Existing pending payment for ${user.username}. Skipping payment until the last pending payment clears.`,
            );
            continue;
        }

        const payout = Payout.fromBalance(balance);
        payout.setUser(user);

        if (user.payout_threshold > 0) {
            // payout_threshold is in piconeros
            payout.setCustomPayoutThreshold(user.payout_threshold / 1000000);
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
                debug(`Payment for ${payout.username} has a zero amount.`);
                continue;
            }

            pendingPayoutUsers.push(payout.user.id);
            if (payout.bitcoin) {
                console.log(
                    '[+] ' +
                        payout.balanceId +
                        ' as separate payment to bitcoin. Amount: ' +
                        support.coinToDecimal(payout.amount),
                );
                // TODO: Support bitcoin payments in future?
                console.warn(`Bitcoin payment not supported. Payment to ${payout.address} skipped`);
                // payment.makeBitcoinPayment();
                continue;
            }

            // Collect the payments to be done
            console.log(
                `[++] ${payout.username()} miner to bulk payment. Amount: ${support.coinToDecimal(
                    payout.amount,
                    coin,
                )}`,
            );
            pendingPayouts.push(payout);
        } else {
            console.log(
                `[+] Payout for user ${payout.username()} not completed because it falls below payout threshold (${
                    payout.payoutThreshold * TARI_SIG_DIGITS
                }`,
            );
        }
    }

    return pendingPayouts;
}

function logError(defautlVal = undefined) {
    return (err) => {
        console.error(err);
        return defautlVal;
    };
}

async function executePayouts(payouts) {
    const client = connectTariWalletGrpc();

    const recipients = payouts.map((p) => ({
        address: p.getCoinAddress(),
        amount: p.amount,
        fee_per_gram: p.feePerGram,
        message: `🎱💸 ${p.poolType} wallet: ${p.balanceId}`,
    }));

    const { version } = await client.getVersion().catch(logError({}));
    console.log(`Transferring funds using wallet v${version}`);

    const { results } = await client.transfer({ recipients }).catch(logError({}));
    if (!results) {
        throw new Error('GRPC transfer call failed');
    }
    // Process the results and update balances
    for (const result of results) {
        const payout = payouts.find((p) => p.getCoinAddress() === result.address);
        if (!payout) {
            throw new Error(
                `Wallet GRPC returned result for an address we didn't request! Address not found: ${result.getCoinAddress()}`,
            );
        }
        if (result.is_success) {
            // Insert a pending payout to be monitored
            // TODO: This should be atomic!
            await db.pendingPayouts.insert({
                txId: result.transaction_id,
                userId: payout.user.id,
                balanceId: payout.balanceId,
                paymentAddress: result.address,
                paymentId: payout.paymentId,
                amount: payout.amount,
                status: 'pending',
            });
            await db.balance.lock(payout.balanceId);
        } else {
            console.warn(
                `Failed to submit payout for ${payout.amount} µT ${payout.username()}: '${result.failure_message}'.`,
            );
            console.warn('Payout will be retried in the next payout cycle.');
        }
    }
}

function Payout(balanceId, address, amount, poolType, paymentId, coin) {
    if (!address) {
        throw new Error('Payout address cannot be null');
    }

    const payout = config.payout;

    this.balanceId = balanceId;
    this.amount = amount;
    this.paymentId = paymentId;
    this.poolType = poolType;
    this.payoutThreshold = payout.defaultPay;
    this.baseFee = support.decimalToCoin(payout.feeSlewAmount, coin);
    this.feePerGram = config.coin.feePerGram || 20;
    this.coin = coin;
    // this.fee = null;

    this.username = () => {
        if (!this.user) {
            return null;
        }

        let username = this.user.username;
        if (this.paymentId) {
            return `${username}.${this.paymentId}`;
        }
        return username;
    };
    this.getCoinAddress = () => aux.tryExtractAddress(address, this.coin);

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

    this.isWithinThreshold = () => this.amount >= this.payoutThreshold;
    this.setUser = (user) => {
        this.user = user;
    };
}

Payout.fromBalance = (balance) => {
    return new Payout(
        balance.id,
        balance.payment_address,
        balance.amount,
        balance.pool_type,
        balance.paymentID,
        balance.coin,
    );
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

        const [err, resp] = await getTariWalletClient()
            .getTransactionInfo({
                transaction_ids: pendingPayouts.map((p) => p.tx_id),
            })
            .then((r) => [null, r])
            .catch((e) => [e, null]);

        if (err) {
            console.error(`Unable to retrieve transactions. ${JSON.stringify(err)}`);
            return;
        }

        if (resp.transactions.length !== pendingPayouts.length) {
            debug('resp.transactions.length !== pendingPayouts.length:', resp);
        }

        for (const transaction of resp.transactions) {
            let pendingPayout = pendingPayouts.find((p) => p.tx_id === transaction.tx_id);
            if (!pendingPayout) {
                throw new Error(`Base node returned a transaction ID (${transaction.tx_id}) that was not requested`);
            }

            console.log(transaction);
            if (!transaction.is_found) {
                console.warn(`Transaction ${transaction.tx_id} was not found! Trying again later.`);
                await db.pendingPayouts.update(pendingPayout.id, { last_checked_at: 'now()' });
                continue;
            }

            if (transaction.is_cancelled) {
                console.log(`Transaction ${transaction.tx_id} was cancelled. Removing pending payout`);
                this.cancelPayout(pendingPayout);
                continue;
            }
            switch (transaction.status) {
                case 'TRANSACTION_STATUS_BROADCAST':
                case 'TRANSACTION_STATUS_COMPLETED':
                case 'TRANSACTION_STATUS_MINED_UNCONFIRMED':
                case 'TRANSACTION_STATUS_PENDING': {
                    console.log(
                        `Transaction ${transaction.tx_id} is still pending/waiting to be mined (status = ${transaction.status})`,
                    );
                    await db.pendingPayouts.update(pendingPayout.id, { last_checked_at: 'now()' });
                    break;
                }

                case 'TRANSACTION_STATUS_MINED_CONFIRMED': {
                    console.log(`Transaction ${transaction.tx_id} has been completed successfully!`);
                    let paymentId = await this.handleSuccessfulPayout(pendingPayout, transaction);
                    debug(
                        `Setting pending payout status to complete (id = ${pendingPayout.id}), payment_id = ${paymentId}`,
                    );
                    await db.pendingPayouts.update(pendingPayout.id, {
                        status: 'complete',
                        payment_id: paymentId,
                        last_checked_at: 'now()',
                    });
                    break;
                }

                default: {
                    console.error(
                        `Unexpected transaction status ${transaction.status} for transaction ${transaction.tx_id}`,
                    );
                    break;
                }
            }
        }
    };

    this.cancelPayout = async (payout) => {
        debug(`Unlocking payout ${JSON.stringify(payout)}`);
        // TODO: atomic
        await db.pendingPayouts.update(payout.id, { status: 'cancelled', last_checked_at: 'now()' });
        await db.balance.unlock(payout.balanceId);
    };

    this.handleSuccessfulPayout = async (pendingPayout, transaction) => {
        console.log(
            `[*] Successful payment to ${pendingPayout.payment_address} of ${support.coinToDecimal(
                transaction.amount,
                'xtr',
            )} µT with tx_id ${transaction.tx_id}`,
        );

        // TODO: Should be in SQL transaction
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
            throw new Error(
                `Failed to insert transaction. No rows affected for payout ${
                    pendingPayout.balanceId
                }, username = '${pendingPayout.username()}'`,
            );
        }

        pendingPayout.transactionId = result.insertId;
        pendingPayout.tx_hash = transaction.transaction_hash;
        pendingPayout.tx_key = '';

        console.log(
            `Reducing balance ${pendingPayout.balance_id} by ${pendingPayout.amount} ${pendingPayout.coin} (Ref: ${pendingPayout.id})`,
        );
        await db.balance.updateCustom(pendingPayout.balance_id, 'amount = amount - ?, locked = 0', [
            pendingPayout.amount,
        ]);
        // TODO: This probably needs to go in the block manager since we have a block_id??
        let { insertId: paymentId } = await db.payments.insert({
            poolType: pendingPayout.poolType,
            address: pendingPayout.payment_address,
            transactionId: pendingPayout.transactionId,
            bitcoin: pendingPayout.bitcoin,
            amount: +pendingPayout.amount - transaction.fee,
            paymentId: pendingPayout.paymentId,
            transferFee: transaction.fees,
            blockId: null, // ????
            coin: 'xtr',
        });

        let user = await db.users.get(pendingPayout.user_id);
        if (!user) {
            console.warn(`Expected to find user ${pendingPayout.user_id} but did not`);
            return paymentId;
        }
        if (user.enable_email) {
            // // toAddress, subject, body
            // const emailData = {
            //     address: payout.username(),
            //     address2: payout.id,
            //     payment_amount: global.support.coinToDecimal(payout.amount - payout.fee),
            //     amount: global.support.coinToDecimal(payout.amount),
            //     fee: global.support.coinToDecimal(payout.fee),
            //     tx_hash: payout.tx_hash,
            //     tx_key: payout.tx_key
            // };

            support.sendEmail(
                user.email,
                `Your ${pendingPayout.amount} µT  payment was just performed`,
                `Your payment of ${support.coinToDecimal(pendingPayout.amount, 'xtr')} µT  (with tx fee ${
                    transaction.fee
                } µT) to ${pendingPayout.address} wallet was just performed and total due was decreased by ${
                    pendingPayout.amount
                } µT.\n`,
                pendingPayout.address,
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
                debug('PendingPayoutMonitor sleeping...');
                await sleep(options.pollInterval);
            } catch (err) {
                if (!onError) {
                    return;
                }
                if (!(await onError(err))) {
                    return;
                }
            }
        }
    };

    this.stop = () => {
        is_stopped = true;
    };
}

PendingPayoutMonitor.new = (opts) => new PendingPayoutMonitor(opts);

async function main() {
    let pendingPayoutsMonitor = PendingPayoutMonitor.new({
        maxPendingQueryLimit: 100,
        pollInterval: 10 * 1000,
    });

    try {
        pendingPayoutsMonitor
            .start(async (err) => {
                console.error(`Pending payout monitor error: ${err}`);
                await sleep(5 * 1000);
                // true means "error handled, please resume operations",
                return true;
            })
            .then(() => {
                console.log('Pending payout monitor stopped');
            });

        while (true) {
            try {
                const payouts = await fetchDuePayouts('xtr');
                debug(`${payouts.length} µT payout(s) that are due to be paid.`);
                if (payouts.length > 0) {
                    await executePayouts(payouts);
                }
                debug('sleeping...');
                await sleep(10 * 1000);
            } catch (err) {
                console.error(err);
            }
        }
    } catch (err) {
        pendingPayoutsMonitor.stop();
        throw err;
    }
}

// Run XMR payments
require('./xmr');

main().catch(console.error);
