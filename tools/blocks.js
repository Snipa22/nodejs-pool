const valid_actions = ['finder', 'stats', 'list'];
let error = 0;

if (!global.argv.hasOwnProperty('action') || valid_actions.indexOf(global.argv.action) === -1) {
    console.error("No action provided to block module.");
    console.error("Valid actions: " + valid_actions.join(', '));
}

switch (global.argv.action) {
    case 'finder':
        if (!global.argv.hasOwnProperty('value')) {
            console.error('No block provided in value field.  Please use --value=blockID');
            error = 1;
            break;
        }
        let blockID = parseInt(global.argv.value);
        let block_data = global.database.getBlockByID(blockID);
        /*
         required string hash = 1;
         required int64 difficulty = 2;
         required int64 shares = 3;
         required int64 timestamp = 4;
         required POOLTYPE poolType = 5;
         required bool unlocked = 6;
         required bool valid = 7;
         optional int64 value = 8;
         */
        if (!block_data) {
            console.error("Invalid blockID provided.");
            error = 1;
            break;
        }
        console.log("Data for block: " + blockID + '\n' +
            'Hash: ' + block_data.hash + '\n' +
            'Difficulty: ' + block_data.hash + '\n' +
            'Hashes Required: ' + block_data.hash + '\n' +
            'Find Time: ' + block_data.hash + '\n' +
            'Pool Type: ' + block_data.hash + '\n' +
            'Unlocked: ' + block_data.hash + '\n' +
            'Valid: ' + block_data.hash + '\n' +
            'Value: ' + block_data.hash + '\n');
}

process.exit(error);