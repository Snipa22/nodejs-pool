#!/bin/bash
echo "This assumes that you are doing a green-field install.  If you're not, please exit in the next 15 seconds."
sleep 15
echo "Continuing install, this will prompt you for your password if you're not already running as root and you didn't enable passwordless sudo.  Please do not run me as root!"
if [[ `whoami` == "root" ]]; then
    echo "You ran me as root! Do not run me as root!"
    exit 1
fi
CURUSER=$(whoami)
sudo timedatectl set-timezone Etc/UTC
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
sudo DEBIAN_FRONTEND=noninteractive apt-get -y install git python-virtualenv python3-virtualenv curl ntp build-essential screen cmake pkg-config libboost-all-dev libevent-dev libunbound-dev libminiupnpc-dev libunwind8-dev liblzma-dev libldns-dev libexpat1-dev libgtest-dev libzmq3-dev
cd ~
git clone https://github.com/Snipa22/nodejs-pool.git  # Change this depending on how the deployment goes.
cd /usr/src/gtest
sudo cmake .
sudo make
sudo mv libg* /usr/lib/
cd ~
sudo systemctl enable ntp
cd /usr/local/src
sudo git clone https://github.com/monero-project/monero.git
cd monero
sudo git checkout v0.11.0.0
curl https://raw.githubusercontent.com/Snipa22/nodejs-pool/master/deployment/monero_daemon.patch | sudo git apply -v
sudo make -j$(nproc)
sudo cp ~/nodejs-pool/deployment/monero.service /lib/systemd/system/
sudo useradd -m monerodaemon -d /home/monerodaemon
BLOCKCHAIN_DOWNLOAD_DIR=$(sudo -u monerodaemon mktemp -d)
sudo -u monerodaemon wget --limit-rate=50m -O $BLOCKCHAIN_DOWNLOAD_DIR/blockchain.raw https://downloads.getmonero.org/blockchain.raw
sudo -u monerodaemon /usr/local/src/monero/build/release/bin/monero-blockchain-import --input-file $BLOCKCHAIN_DOWNLOAD_DIR/blockchain.raw --batch-size 20000 --database lmdb#fastest --verify off --data-dir /home/monerodaemon/.bitmonero
sudo -u monerodaemon rm -rf $BLOCKCHAIN_DOWNLOAD_DIR
sudo systemctl daemon-reload
sudo systemctl enable monero
sudo systemctl start monero
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.0/install.sh | bash
source ~/.nvm/nvm.sh
nvm install v8.9.3
cd ~/nodejs-pool
npm install
npm install -g pm2
openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.pool" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
cd ~
sudo env PATH=$PATH:`pwd`/.nvm/versions/node/v8.9.3/bin `pwd`/.nvm/versions/node/v8.9.3/lib/node_modules/pm2/bin/pm2 startup systemd -u $CURUSER --hp `pwd`
sudo chown -R $CURUSER. ~/.pm2
echo "Installing pm2-logrotate in the background!"
pm2 install pm2-logrotate &
echo "You're setup with a leaf node!  Congrats"
