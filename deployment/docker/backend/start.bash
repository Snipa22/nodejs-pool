#!/bin/bash

set -eo pipefail

DB_STORAGE_PATH=${DB_STORAGE_PATH:-$POOL_DIR/pool_db}
COIN=${COIN:-xmr}

cd $POOL_DIR/pool
cat > config.json <<-EOF
{
  "pool_id": 0,
  "bind_ip": "0.0.0.0",
  "hostname": "${POOL_HOSTNAME}",
  "db_storage_path": "${DB_STORAGE_PATH}",
  "coin": "${COIN}",
  "mysql": {
    "connectionLimit": 20,
    "host": "${DB_HOST}",
    "database": "${DB_NAME}",
    "user": "${DB_USER}",
    "password": "${DB_PASS}"
  }
}
EOF

echo "Waiting for MySQL to come online"
WAIT_HOSTS=$DB_HOST:$DB_PORT wait-util

function exec_sql() {
  mysql -u root --password=$ROOT_SQL_PASS -h ${DB_HOST} -sN  pool -e "$@"
}

cd ~/pool

RESULT=`exec_sql "SELECT COUNT(1) \
    FROM information_schema.tables \
    WHERE table_schema = 'pool' \
    LIMIT 1"`
if [[ "$RESULT" == "0" ]]; then
  echo "+ Setting up pool database"
  exec_sql "CREATE USER IF NOT EXISTS pool@'%' IDENTIFIED BY '$DB_USER';";
  exec_sql "FLUSH PRIVILEGES;"
  mysql -u root --password=$ROOT_SQL_PASS -h ${DB_HOST} < deployment/docker/api/base.sql
  exec_sql "INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'authKey', '`cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1`', 'string', 'Auth key sent with all Websocket frames for validation.')"
  exec_sql "INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'secKey', '`cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1`', 'string', 'HMAC key for Passwords.  JWT Secret Key.  Changing this will invalidate all current logins.')"
else
  echo "+ Pool database already setup"
fi

pushd sql_sync/
node sql_sync
popd

pm2-runtime ./deployment/docker/backend/stack.yml --only "$ENABLED_DAEMONS"
