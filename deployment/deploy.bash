#!/bin/bash
echo "This assumes that you are doing a green-field install.  If you're not, please exit in the next 15 seconds."
sleep 15
echo "Continuing install, this will prompt you for your password if you're not already running as root and you didn't enable passwordless sudo.  Please do not run me as root!"
if [[ `whoami` == "root" ]]; then
    echo "You ran me as root! Do not run me as root!"
    exit 1
fi
ROOT_SQL_PASS=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)
CURUSER=$(whoami)
echo "Etc/UTC" | sudo tee -a /etc/timezone
sudo rm -rf /etc/localtime
sudo ln -s /usr/share/zoneinfo/Zulu /etc/localtime
sudo dpkg-reconfigure -f noninteractive tzdata
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
sudo debconf-set-selections <<< "mysql-server mysql-server/root_password password $ROOT_SQL_PASS"
sudo debconf-set-selections <<< "mysql-server mysql-server/root_password_again password $ROOT_SQL_PASS"
echo -e "[client]\nuser=root\npassword=$ROOT_SQL_PASS" | sudo tee /root/.my.cnf
sudo DEBIAN_FRONTEND=noninteractive apt-get -y install git python-virtualenv python3-virtualenv curl ntp build-essential screen cmake pkg-config libboost-all-dev libevent-dev libunbound-dev libminiupnpc-dev libunwind8-dev liblzma-dev libldns-dev libexpat1-dev libgtest-dev mysql-server lmdb-utils
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
sudo git checkout 15eb2bcf6f2132c5410e937186b6a3121147d628
sudo git apply ~/nodejs-pool/deployment/fluffy.patch
sudo make -j 4
sudo cp ~/nodejs-pool/deployment/monero.service /lib/systemd/system/
sudo useradd -m monerodaemon -d /home/monerodaemon
wget -O /tmp/blockchain.raw https://downloads.getmonero.org/blockchain.raw
sudo -u monerodaemon /usr/local/src/monero/build/release/bin/monero-blockchain-import --input-file /tmp/blockchain.raw --batch-size 20000 --database lmdb#fastest --verify off --data-dir /home/monerodaemon/.bitmonero
rm -f /tmp/blockchain.raw
sudo systemctl daemon-reload
sudo systemctl enable monero
sudo systemctl start monero
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.0/install.sh | bash
source ~/.nvm/nvm.sh
nvm install v6.9.2
cd ~/nodejs-pool
npm install
npm install -g pm2
openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.pool" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
mkdir ~/pool_db/
cp config_example.json config.json
cd ~
git clone https://github.com/mesh0000/poolui.git
cd poolui
npm install
cd app
sudo ln -s `pwd` /var/www
cd /tmp/
wget -O caddy.tar.gz 'https://caddyserver.com/download/build?os=linux&arch=amd64&features=cors'
tar -xf caddy.tar.gz
sudo cp caddy /usr/local/bin
sudo chown root:root /usr/local/bin/caddy
sudo chmod 755 /usr/local/bin/caddy
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/caddy
sudo groupadd -g 33 www-data
sudo useradd -g www-data --no-user-group --home-dir /var/www --no-create-home --shell /usr/sbin/nologin --system --uid 33 www-data
sudo mkdir /etc/caddy
sudo chown -R root:www-data /etc/caddy
sudo mkdir /etc/ssl/caddy
sudo chown -R www-data:root /etc/ssl/caddy
sudo chmod 0770 /etc/ssl/caddy
sudo cp ~/nodejs-pool/deployment/caddyfile /etc/caddy/Caddyfile
sudo chown www-data:www-data /etc/caddy/Caddyfile
sudo chmod 444 /etc/caddy/Caddyfile
sudo cp /tmp/init/linux-systemd/caddy.service /etc/systemd/system/
sudo chown root:root /etc/systemd/system/caddy.service
sudo chmod 744 /etc/systemd/system/caddy.service
sudo sed -i 's/ProtectHome=true/ProtectHome=false/' /etc/systemd/system/caddy.service
sudo systemctl daemon-reload
sudo systemctl enable caddy.service
sudo systemctl start caddy.service
cd ~
sudo env PATH=$PATH:`pwd`/.nvm/versions/node/v6.9.2/bin `pwd`/.nvm/versions/node/v6.9.2/lib/node_modules/pm2/bin/pm2 startup systemd -u $CURUSER --hp `pwd`
cd ~/nodejs-pool
sudo chown -R $CURUSER. ~/.pm2
echo "Installing pm2-logrotate in the background!"
pm2 install pm2-logrotate &
mysql -u root --password=$ROOT_SQL_PASS < deployment/base.sql
mysql -u root --password=$ROOT_SQL_PASS pool -e "INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'authKey', '`cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1`', 'string', 'Auth key sent with all Websocket frames for validation.')"
mysql -u root --password=$ROOT_SQL_PASS pool -e "INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'secKey', '`cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1`', 'string', 'HMAC key for Passwords.  JWT Secret Key.  Changing this will invalidate all current logins.')"
pm2 start init.js --name=api --log-date-format="YYYY-MM-DD HH:mm Z" -- --module=api
echo "You're setup!  Please read the rest of the readme for the remainder of your setup and configuration.  These steps include: Setting your Fee Address, Pool Address, Global Domain, and the Mailgun setup!"
