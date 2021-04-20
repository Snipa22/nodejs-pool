const { init } = require('../init_mini');
const csv = require('fast-csv');
const args = require('minimist')(process.argv.slice(2));
const fs = require('fs');

const user_id = args['user-id'];
const user_address = args.address;

const output = args.out || args.o || '-';

init(async function () {
    const { database, protos } = global;
    const { db } = require('../lib/common');

    const isStdOut = output === '-';
    const outStream = isStdOut ? process.stdout : fs.createWriteStream(output);

    const csvStream = csv.format({ headers: true });
    csvStream.pipe(outStream).on('finish', () => {
        process.exit();
    });

    const userAddress = user_id
        ? await db.users.get(+user_id).then((user) => {
              if (!user) {
                  throw new Error(`User not found with id ${user_id}`);
              }
              return user.username;
          })
        : user_address;

    let txn = database.env.beginTxn({ readOnly: true });

    let cursor = new database.lmdb.Cursor(txn, database.shareDB);
    for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        do {
            cursor.getCurrentBinary(function (key, data) {
                // jshint ignore:line
                let shareData = protos.Share.decode(data);
                if (!userAddress || shareData.paymentAddress === userAddress) {
                    csvStream.write(shareData);
                }
            });
        } while (cursor.goToNextDup());
    }
    cursor.close();
    txn.commit();
    csvStream.end();

    if (!isStdOut) {
        console.log(`Wrote ${output}.`);
    }
});
