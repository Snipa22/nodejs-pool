
Setup Tari Merge Mining Pool
----------------------------

Support for Tari merge mining has been added to this fork. This allows miners to mine and get paid out for Tari and Monero blocks.

To set up this fork you'll need the following additional components:

1. Tari Base Node

   See the [Tari Download Page](https://www.tari.com/downloads/) for details on setting up a base node.

2. Tari Console Wallet

   There are currently no pre-built binaries available for the Tari Console Wallet. Head over to the [Tari repo](https://github.com/tari-project/tari) and follow the [build instructions](https://github.com/tari-project/tari#building-from-source) instructions.
   Once dependencies are installed

   ```shell
   cargo build --release --bin tari_console_wallet
   # You may copy this binary to somewhere more suitable
   ./target/release/tari_console_wallet 
   ```

   The Merge mining proxy as well as the xtr payments process communicate with the wallet via the gRPC interface. The default address us 127.0.0.1:18143 however this can be changed in `~/.tari/config/config.toml`.

   ```toml
   grpc_console_wallet_address = "127.0.0.1:18143"
   ```

3. Tari Merge Mining Proxy

   The Tari merge mining proxy integrates monerod, the tari base node and console wallet to allow clients (e.g. nodejs-pool) to obtain new monero block templates with Tari merge mining tags.

   ```shell
   cargo build --release --bin tari_merge_mining_proxy
   # You may copy this binary to somewhere more suitable
   ./target/release/tari_merge_mining_proxy 
    ```

**Deployment Steps**

These steps provide a high-level deployment guide using the defaults as much as possible. It assumes that `docker` and `docker-compose` are installed although they are not required at all.
You will almost certainly need to tweak these steps to fit your specific requirements.

Is it assumed that you have already set up nodejs (tested on v10.24.0), the monero daemon and the RPC wallet as detailed in the [README](README.md).

1. Tor

```shell
tor --clientonly 1 --socksport 9050 --controlport 127.0.0.1:9051 --log "notice stdout" --clientuseipv6 1 --SafeLogging 0 --DataDirectory $HOME/.tor/data
```

2. Tari components

Assumes the tari binaries are in your `PATH`.

```shell
# Create a new node identity if necessary
tari_base_node --create-id
# Start the node
tari_base_node

# Start the console wallet and follow the setup steps
tari_console_wallet 
# once setup, you can use `--password` to start the wallet up immediately
tari_console_wallet --password "PASSWORD HERE"

# Start the merge mining proxy
tari_merge_mining_proxy
```

See the [tari config sample](https://github.com/tari-project/tari/blob/development/common/config/tari_config_example.toml) for advanced details on configuring tari binaries.

3. Other required backend components

```shell
# You may start a MySQL server however you'd like. The easiest may be to use the provided docker-compose.yml.
docker-compose up db
# You may also need a monerod instance if you haven't already set one
docker-compose up monerod
```

Database scripts are available in `./deployment/docker/backend/db_scripts`. Run `base.sql` and then the tari changes in `tari.sql`.

4. Pool 

** Configuration **

```shell
# The public address where your pool will be hosted
export POOL_HOSTNAME=xmrpool.net
# Where should the LMDB database live?
export LMDB_STORAGE_PATH=/var/pool-db
# Credentials of the MySQL db
export DB_HOST=localhost
export DB_NAME=pool
export DB_USER=app_user
export DB_PASS=super-secret-password

cat > config.json <<-EOF
{
  "pool_id": 0,
  "bind_ip": "0.0.0.0",
  "hostname": "${POOL_HOSTNAME}",
  "db_storage_path": "${LMDB_STORAGE_PATH}",
  "coin": "xtr",
  "mysql": {
    "connectionLimit": 20,
    "host": "${DB_HOST}",
    "database": "${DB_NAME}",
    "user": "${DB_USER}",
    "password": "${DB_PASS}"
  }
}
EOF
```

Look in the `config` table and change the configuration as necessary. See the [nodejs-pool README](README.md) for more details.

**Running the pool**

```shell
# Ensure pm2 is installed
npm install -g pm2

cd path/to/nodejs-pool
npm install --production
# Start all processes with pm2
pm2 start ./deployment/docker/backend/stack.yml
```

4. Pool UI

```shell
git clone --branch tari https://github.com/tari-project/poolui.git
cd poolui
npm install
npx gulp build
cd build
# You should use a production-ready static HTTP server
python -m SimpleHTTPServer 8080
# open http://localhost:8080
```
