#!/bin/bash
echo "This assumes that you have a standard nodejs-pool install, and will patch and update it to the latest stable builds of Monero."
sleep 15
echo "Continuing install, this will prompt you for your password if you didn't enable passwordless sudo.  Please do not run me as root!"
cd /usr/local/src/monero
sudo git checkout .
sudo git checkout master
sudo git pull
sudo git checkout v0.10.3.1
curl -L https://raw.githubusercontent.com/Snipa22/nodejs-pool/master/deployment/monero_daemon.patch | sudo git apply -v
sudo rm -rf build
sudo make -j$(nproc)
echo "Done building the new Monero daemon!  Please go ahead and reboot monero with: sudo systemctl restart monero as soon as the pool source is updated!"
