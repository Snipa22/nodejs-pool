const { mockdb } = require('./support');

Object.assign(global, {
    __dontRunBlockManager: true,
    config: {
        general: { network: 'stagenet' },
    },
    // database: mockdb.MockDb.new(),
});

let _blockManager = require('../lib/blockManager');

describe('blockManager', () => {
    it('works', async () => {
        // await blockManager.unlockAuxBlocks('xtr');
    });
});
