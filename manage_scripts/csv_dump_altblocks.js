const { init } = require('../init_mini');
const csv = require('fast-csv');
const args = require('minimist')(process.argv.slice(2));
const fs = require('fs');

const output = args.out || args.o || '-';

init(async function () {
    const { database } = global;

    const isStdOut = output === '-';
    const outStream = isStdOut ? process.stdout : fs.createWriteStream(output);

    const csvStream = csv.format({ headers: true });
    csvStream.pipe(outStream).on('finish', () => {
        process.exit();
    });

    for (const block of database.getAltBlockList('pplns')) {
        csvStream.write(block);
    }
    csvStream.end();

    if (!isStdOut) {
        console.log(`Wrote ${output}.`);
    }
});
