const assert = require('assert');

// Setup global state
global.config = {
    general: { network: 'stagenet' },
};

describe('common', () => {
    describe('Aux module', () => {
        const { aux } = require('../lib/common');
        describe('#tryParseMergeMiningAddress()', () => {
            const { tryParseMergeMiningAddress } = aux;
            it('returns address parts if valid', () => {
                const address =
                    '06b9998a8a6001ab17f359cd1371b78e1930f3d99d30f97d93889e3ca664ff2f:51skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF';
                const { tari, monero } = tryParseMergeMiningAddress(address);
                assert.strictEqual(tari, '06b9998a8a6001ab17f359cd1371b78e1930f3d99d30f97d93889e3ca664ff2f');
                assert.strictEqual(
                    monero,
                    '51skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF',
                );
            });

            it('errors if no delimiter', () => {
                const address =
                    '06b9998a8a6001ab17f359cd1371b78e1930f3d99d30f97d93889e3ca664ff2f_51skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF';
                assert.throws(() => {
                    tryParseMergeMiningAddress(address);
                });
            });

            it('errors if invalid tari address', () => {
                const address =
                    'z6b9998a8a6001ab17f359cd1371b78e1930f3d99d30f97d93889e3ca664ff2f:51skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF';
                assert.throws(() => {
                    tryParseMergeMiningAddress(address);
                });
            });

            it('errors if invalid monero address', () => {
                const address =
                    '06b9998a8a6001ab17f359cd1371b78e1930f3d99d30f97d93889e3ca664ff2f:61skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF';
                assert.throws(() => {
                    tryParseMergeMiningAddress(address);
                });
            });
        });

        describe('#getData()', () => {
            it('gets the aux data from rpc response', () => {
                let data = aux.getData({ jsonrpc: '2.0', result: { _aux: { it: 'works' } } });
                assert.strictEqual(data.it, 'works');
            });

            it('gets the aux data from result', () => {
                let data = aux.getData({ _aux: { it: 'works' } });
                assert.strictEqual(data.it, 'works');
            });

            it('gets the aux chain data', () => {
                let data = aux.findChainData({ _aux: { chains: [{ id: 'abc', it: 'works' }] } }, 'abc');
                assert.strictEqual(data.it, 'works');
            });
        });
    });
});
