const cnUtil = require('cryptoforknote-util');
const AUX_KEY_NAME = '_aux';

function findChainData(result, auxName) {
    let chains = getAllAuxChainData(result);
    if (!chains) {
        return null;
    }

    return chains.find((ch) => ch.id === auxName);
}

function getAllAuxChainData(result) {
    const { chains } = getData(result) || {};
    return chains;
}

function getAuxCoinIds(result) {
    const auxData = getData(result) || {};
    if (!auxData.chains) {
        return [];
    }
    return auxData.chains.map((ch) => ch.id);
}

function getData(result) {
    if (result.jsonrpc) {
        return result.result[AUX_KEY_NAME] || null;
    }
    return result[AUX_KEY_NAME] || null;
}

const MERGE_MINING_ADDR_DELIM = ':';
const TARI_ADDRESS_REGEX = new RegExp('[0-9a-fA-F]{64}');

function moneroAddressPrefixLengths(network) {
    switch (network) {
        case 'stagenet':
            return {
                prefix: 24,
                subPrefix: 36,
                integratedPrefix: 25,
            };

        case 'testnet':
            return {
                prefix: 53,
                subPrefix: 63,
                integratedPrefix: 54,
            };

        case 'mainnet':
            return {
                prefix: 18,
                subPrefix: 42,
                integratedPrefix: 19,
            };

        default:
            throw new Error(`Invalid network ${network} specified in config`);
    }
}

function isValidMoneroAddress(address) {
    const network = global.config.general.network;
    const { prefix, subPrefix, integratedPrefix } = moneroAddressPrefixLengths(network);
    const addrBuf = Buffer.from(address);
    let code = cnUtil.address_decode(addrBuf);
    if (code === prefix || code === subPrefix) {
        return true;
    }

    code = cnUtil.address_decode_integrated(addrBuf);
    return code === integratedPrefix;
}

function isValidTariAddress(address) {
    return TARI_ADDRESS_REGEX.test(address);
}

function tryParseMergeMiningAddress(addr) {
    const parts = addr.split(MERGE_MINING_ADDR_DELIM, 2);
    if (parts.length !== 2) {
        throw new Error('Invalid Tari merge mining address: did not contain 2 delimited addresses');
    }
    const [tari, monero] = parts;
    if (!isValidTariAddress(tari)) {
        throw new Error('Invalid Tari merge mining address: invalid characters or incorrect length');
    }
    if (!isValidMoneroAddress(monero)) {
        throw new Error('Invalid monero merge mining address: invalid characters or incorrect length');
    }

    return {
        tari,
        monero,
    };
}

function tryExtractAddress(addr, coin) {
    let { tari, monero } = tryParseMergeMiningAddress(addr);
    switch (coin) {
        case 'xtr':
            return tari;
        case 'xmr':
        default:
            return monero;
    }
}

module.exports = {
    findChainData,
    getData,
    getAllAuxChainData,
    tryParseMergeMiningAddress,
    tryExtractAddress,
    getAuxCoinIds,
};
