#!/usr/bin/env bash

set -e

WORKDIR=$(mktemp -d)

echo "+ Installing wait utility (wait for mysql before starting)"
mkdir $POOL_DIR/.bin
cd $POOL_DIR/.bin
curl -Lo ./wait-util https://github.com/ufoscout/docker-compose-wait/releases/download/2.7.3/wait
chmod +x ./wait-util

echo "+ Setting up NodeJS"
curl -o$WORKDIR/node.tar.gz  https://nodejs.org/dist/latest-v10.x/node-v10.24.0-linux-x64.tar.gz
cd $WORKDIR
tar -xf node.tar.gz
mv node-v10.24.0-linux-x64/ $POOL_DIR/.nodejs/

# echo "+ Cloning nodejs-pool source"
# cd $POOL_DIR
# git clone https://github.com/Snipa22/nodejs-pool.git pool

echo "+ Installing nodejs-pool dependencies"
mkdir -p $POOL_DIR/pool_db/ $POOL_DIR/keys
cd $POOL_DIR/pool
npm install --production
npm install -g pm2
openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.pool" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500

echo "+ Installing pm2-logrotate"
pm2 install pm2-logrotate

rm -fr $WORKDIR
echo "You're setup!  Please read the rest of the readme for the remainder of your setup and configuration.  These steps include: Setting your Fee Address, Pool Address, Global Domain, and the Mailgun setup!"
