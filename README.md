<div align="center">

# nodejs-pool

Node.js mining pool backend with LMDB share storage, MySQL-backed configuration, and a modular PM2 runtime.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.9.0-brightgreen.svg" alt="Node >=22.9.0">
  <img src="https://img.shields.io/badge/platform-Ubuntu%2024.04-lightgrey.svg" alt="Ubuntu 24.04">
  <img src="https://img.shields.io/badge/focus-pool%20backend-1f6feb.svg" alt="Pool backend">
  <a href="https://github.com/MoneroOcean"><img src="https://img.shields.io/badge/MoneroOcean-ecosystem-6f42c1.svg" alt="MoneroOcean"></a>
</p>

</div>

## Overview

`nodejs-pool` is the backend used for MoneroOcean-style mining pool deployments. It keeps share state in LMDB, stores configuration and accounting in MySQL, and splits runtime responsibilities into small services that can be scaled or restarted independently.

The backend is typically paired with the static [`mo-pool-ui`](https://github.com/MoneroOcean/mo-pool-ui) frontend and points it at the API service exposed by this repo.

## Service Layout

| Module | Purpose |
| --- | --- |
| `api` | Main frontend and account API, typically exposed on port `8001` |
| `remote_share` | Share ingress for local/remote pool nodes, typically exposed on port `8000` at `/leafApi` |
| `pool` | Stratum/miner entrypoint |
| `block_manager` | Unlocks blocks and distributes rewards |
| `payments` | Handles miner payouts |
| `worker` | Refreshes stats, health checks, and notifications |
| `long_runner` | Cleans and compacts share data over time |
| `pool_stats` | Aggregates pool statistics |
| `altblock_manager` / `altblock_exchange` | Optional multi-coin helpers under [`lib2/`](lib2/) |

## Quick Setup

### What You Need

- A clean Ubuntu `24.04` x86_64 or arm64 server
- Root access for the initial installer run
- Cloudflare-managed DNS for both the website hostname and API hostname
- A Cloudflare API token with `Zone.Zone (Read)` and `Zone.DNS (Edit)`
- At least `8 GB RAM`, `2 CPU cores`, and about `150 GB` of SSD storage for a single-node XMR deployment
- More storage if you plan to run extra daemons or optional `lib2` services

Leaf nodes need far less disk than a full single-node install because they do not need the full main-server footprint.

At startup, the backend removes the compromised `emSign ECC Root CA - G3` from Node's default TLS trust before loading application dependencies. Automatic filtering requires Node's CA APIs, available in Node `22.19+` and `24.5+`. On older runtimes, use `--use-openssl-ca` with an updated system CA store; startup refuses a bundled store that still contains the blocked root and cannot be filtered. Explicit per-connection CA settings and pinned mining certificates are preserved.

Pearl proof uploads use raw transport for localhost and loopback verifiers, and gzip for remote
verifiers when smaller. The pool forwards validated miner gzip unchanged, or compresses raw proofs
asynchronously. Remote verifiers must support gzip proof frames before updating the pool.

Pearl block submissions always send the large `plain_proof` field as gzip base64 inside the existing
JSON-RPC request, with `proof_encoding: "gzip"` and the exact `proof_raw_bytes` length. Validated
miner gzip and cached verifier gzip are reused without recompression. Upgrade the mining gateway
to accept this format before updating a pool sender; the gateway must continue accepting legacy
raw base64 submissions during a staged rollout.

> The deploy scripts assume a fresh host. They create a `user` account, install Monero, MySQL, Nginx, Node via NVM, PM2, wallet files, SQL schema, and base pool configuration.

If your DNS or certificate flow is different, adapt [`deployment/deploy.bash`](deployment/deploy.bash) before running it.

### Single-Server Deploy

Run the installer as `root`:

```bash
curl -L https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/deploy.bash | \
WWW_DNS=pool.example.com API_DNS=api.pool.example.com CF_DNS_API_TOKEN="Cloudflare API Token" CERTBOT_EMAIL=ops@example.com bash
```

`WWW_DNS`, `API_DNS`, and `CERTBOT_EMAIL` default to the MoneroOcean production values if omitted. Set them explicitly for any non-production install.
Set `MONERO_RELEASE_TAG` (default `v0.18.5.1`) or `TARI_RELEASE_TAG` (default `v6.0.0`) to override a source tag. `MONERO_REPO_URL` and `TARI_REPO_URL` can point at reviewed forks. Tari is built from source into `/usr/local/src/tari/target/release`.

When the script finishes:

1. Switch to the pool user and load Node from NVM.
2. Review `/home/user/nodejs-pool/config.json`.
3. Update `bind_ip`, `hostname`, `pool_id`, and any SQL-backed pool settings you want to change before miners connect.
4. Start the `pool` module manually after you finish review.

```bash
su - user
cd ~/nodejs-pool
source ~/.nvm/nvm.sh
NODE_CLUSTER_SCHED_POLICY=none pm2 start init.js --name=pool --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
pm2 save
```

`NODE_CLUSTER_SCHED_POLICY=none` selects direct worker acceptance and matches the pool default.
Apply it to an existing PM2 app with:

```bash
NODE_CLUSTER_SCHED_POLICY=none pm2 restart pool --update-env
pm2 save
```

### Important Paths

| Path | Purpose |
| --- | --- |
| `/home/user/nodejs-pool/config.json` | Main local runtime config |
| `/home/user/mo-pool-ui/` | Static frontend source checkout |
| `/var/www/mo-pool-ui/` | Built frontend served by Nginx |
| `/home/user/pool_db/` | LMDB share database |
| `/home/user/wallets/` | Generated XMR pool and fee wallet files |
| `/root/mysql_pass` | MySQL root password created by the installer |
| `pool.port_config` | Mining ports and difficulty settings stored in MySQL |

### Leaf Nodes

Before a leaf-only install, prepare the pool checkout at `/home/user/nodejs-pool` and provision the pool's existing `cert.pem` and `cert.key` there through a trusted channel, owned by the `user` account. Keep `cert.key` private (mode `600`). The leaf installer requires the complete, valid pair and preserves it.

```bash
curl -L https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/leaf.bash \
  | TARI_WALLET_PAYMENT_ADDRESS=<your_tari_wallet_address> bash
```

`TARI_WALLET_PAYMENT_ADDRESS` is required so Tari merge-mining rewards are paid to a wallet you control.
Set `MONERO_RELEASE_TAG` or `TARI_RELEASE_TAG` before `bash` to use a different reviewed release tag on leaf nodes.
Leaf installs retain 10,000 Tari blocks by default; override this with `TARI_PRUNING_HORIZON` when more history is required.
The installer disables root/password SSH access and enables an SSH Fail2ban jail. Set `SSH_FAIL2BAN_IGNORE_IPS` to a whitespace-separated list of trusted management addresses or CIDRs that must never be banned; SSH itself remains reachable from any address allowed by UFW.
Site-specific trust settings can be stored in `/etc/moneroocean/leaf.conf`, which must be a root-owned regular file without group/other write permissions. Keep it outside the repository and use shell assignments such as `SSH_FAIL2BAN_IGNORE_IPS="..."` and `POOL_TRUSTED_SOURCE_IPV4S="..."`; the latter is a comma-separated IPv4 list. Override the path with `LEAF_CONFIG_FILE` when needed.
For staged provisioning, set `LEAF_SKIP_SYNC_WAIT=1` to install and start the local daemons without waiting for synchronization; after they report synced, rerun with `LEAF_FINALIZE_SYNC_ONLY=1` to enable block notifications and merge mining. These modes are mutually exclusive. `MONERO_P2P_SOURCE_IPV4S` is an optional comma-separated IPv4 list allowed TCP port 18080 only.
Fresh daemon synchronization can take hours. `MONERO_SYNC_TIMEOUT_SECONDS` and `TARI_SYNC_TIMEOUT_SECONDS` default to 172,800 seconds and accept `0` for no timeout.

The installers load `deployment/common.bash` from a local checkout when available. In the documented curl-pipe form they fetch the reviewed helper over HTTPS into a private temporary file; they do not read deployment files from the caller's working directory. Installer output intentionally avoids shell tracing so credentials and other environment values are not echoed.

After install, update the leaf config so it points at the main pool infrastructure, then start the `pool` module on that node.

Share delivery uses pinned HTTPS on port 80: set `general.shareHost` to `https://<receiver>:80/leafApi` and restrict that port to trusted leaves. Mining TLS and the receiver reuse `cert.pem` and `cert.key`; sender pinning also uses `cert.pem`. The central installer generates a pair only when both files are absent. Provision the same existing pair on fresh leaves before installing or starting the pool, and coordinate certificate replacement across the receiver and all senders.

### Docker And Optional Multi-Coin Stack

The Docker-based setup and the optional `lib2` altblock stack live in [`lib2/README.md`](lib2/README.md). Use that path if you are building out the broader multi-coin environment rather than the simpler default install.

## Manual / Dev Notes

- `package.json` requires Node `>=22.9.0` and npm `>=11.10.0`
- `config_example.json` provides the base local config shape
- The SQL schema is in [`deployment/base.sql`](deployment/base.sql)
- See the [Testing](#testing) section below for the available test suites

## Operational Notes

- The deploy script starts most services for you, but leaves `pool` to be started after config review.
- To redeploy the frontend after a UI update, run `cd ~/mo-pool-ui && npm ci && npm run build` as the `user` account.
- The default SQL schema is XMR-oriented; adapt SQL-backed config if you are building for something else.
- Mining ports are not hardcoded in `config.json`; they are read from MySQL table `pool.port_config`.
- Existing miner sessions are audited against cached permanent wallet bans every six hours, in small batches from the regular housekeeping callback. This adds no ban queries or checks to share processing; payout-split recipients are checked too.
- If LMDB appears stuck or the API stops moving, start with `mdb_stat -fear ~/pool_db/` and then review PM2 service state.

## Testing

The test suite uses the built-in Node.js test runner. Run the full suite with:

```bash
npm test
```

Additional suites are defined in `package.json`:

| Command | Scope |
| --- | --- |
| `npm test` | Lint, strict JavaScript type checks, and full local suite (`tests/all.js`) |
| `npm run typecheck` | Check production JavaScript and compile-only contract tests; also check `lib2` when installed |
| `npm run test:deploy` | Deployment-oriented checks (`tests/deploy.js`) |
| `npm run test:live` | Live integration checks against a running pool (`tests/live.js`) |
| `npm run test:live:sg` | Live checks targeting `sg.moneroocean.stream` |

Type checks use TypeScript with JSDoc and inference; there is no build step. Annotate public contracts and ambiguous boundaries, and let TypeScript infer ordinary local values. Validate optional input at the boundary before passing it into core functions. Compile-only tests in `tests/typecheck/` also verify that invalid inputs remain rejected.

Caveats:

- Dependencies include native addons ([`node-blocktemplate`](https://github.com/MoneroOcean/node-blocktemplate), [`node-powhash`](https://github.com/MoneroOcean/node-powhash), `node-lmdb`) that must compile against your toolchain on `npm install`.
- The live suites (`test:live*`) require network access to a reachable pool host and are not suitable for offline/CI-only runs.
- Live miner archives resolve the current GitHub release before consulting the release-keyed cache. Set `NODEJS_POOL_LIVE_MOM_RELEASE_TAG` for an explicit, validated MoM release tag; cached archives are reused only after their GitHub SHA-256 digest matches.
- PearlHash live coverage is opt-in with `NODEJS_POOL_LIVE_ALGOS=pearlhash`; it is intended for a compatible Intel-GPU loopback qualification and is not part of the default CPU-safe live set.

## Setup And Support

| Offering | Price |
| --- | --- |
| Setup | `1 XMR` |
| Setup support | `3 XMR` |

SSH access with a sudo-capable user and working DNS is expected for hands-on help.

Contact: `support@moneroocean.stream`

## Donation

If you want to quietly support the project:

```text
89TxfrUmqJJcb1V124WsUzA78Xa3UYHt7Bg8RGMhXVeZYPN8cE5CZEk58Y1m23ZMLHN7wYeJ9da5n5MXharEjrm41hSnWHL
```

## Contributors

- [MoneroOcean](https://github.com/MoneroOcean) for the long-running maintenance branch, deployment work, multi-coin evolution, and the recent hardening and test coverage push
- Alexander Blair and [Snipa22](https://github.com/Snipa22) for the original public `nodejs-pool` codebase and early architecture
- [Zone117x](https://github.com/zone117x) for the original [node-cryptonote-pool](https://github.com/zone117x/node-cryptonote-pool) stratum foundation
- [1rV1N](https://github.com/1rV1N), Mine Coins, Learner, [M5M400](https://github.com/M5M400), and [techandbeers](https://github.com/techandbeers) for fixes, docs, and operational improvements
- [Wolf0](https://github.com/wolf9466/) and [OhGodAGirl](https://github.com/ohgodagirl) for AES-NI hashing work used by the broader pool stack

## MoneroOcean ecosystem

| Component | Role |
| --- | --- |
| [nodejs-pool](https://github.com/MoneroOcean/nodejs-pool) | Pool backend — stratum, share storage, payments |
| [mo-pool-ui](https://github.com/MoneroOcean/mo-pool-ui) | Static web frontend for the pool |
| [xmr-node-proxy](https://github.com/MoneroOcean/xmr-node-proxy) | Stratum proxy / share aggregator |
| [mo-miner](https://github.com/MoneroOcean/mo-miner) | MoneroOcean end-user CPU/GPU mining client (multi-algo) |
| [multi-miner](https://github.com/MoneroOcean/multi-miner) | Multi-algo miner manager |
| [node-powhash](https://github.com/MoneroOcean/node-powhash) | Native multi-algo PoW hashing addon |
| [node-randomx](https://github.com/MoneroOcean/node-randomx) | Native RandomX hashing addon |
| [node-blocktemplate](https://github.com/MoneroOcean/node-blocktemplate) | Native block-template & serialization addon |
| [grpc-json-proxy](https://github.com/MoneroOcean/grpc-json-proxy) | gRPC ↔ JSON-RPC proxy (Tari base node) |

## License

Released under the [MIT License](LICENSE).
