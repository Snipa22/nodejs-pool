async function fetchOne(sql, args) {
    let results = await fetchMany(sql, args);
    if (results.length === 0) {
        return null;
    } else {
        return results[0];
    }
}

function fetchMany(sql, args) {
    return execute(sql, args);
}

async function execute(sql, args) {
    return await new Promise((resolve, reject) => {
        global.mysql.query(sql, args, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

module.exports = {
    escape: (...args) => mysql.escape(...args),
    fetchOne,
    fetchMany,
    execute,
};