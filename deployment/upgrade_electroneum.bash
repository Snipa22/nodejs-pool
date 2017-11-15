#!/bin/bash
echo "This assumes that you have 3DITGuy ETN nodejs-pool install, and will patch and update it to the latest stable builds of Electroneum."
sleep 15
echo "Continuing install, this will prompt you for your password if you didn't enable passwordless sudo.  Please do not run me as root!"
cd /usr/local/src/electroneum
sudo git checkout .
sudo git checkout master
sudo git pull
sudo git checkout origin/release-v0.11.0.0
curl -L https://raw.githubusercontent.com/3ditguy/nodejs-pool/master/deployment/electroneum_daemon.patch | sudo git apply -v
sudo rm -rf build
sudo make -j$(nproc)
echo "Done building the new electroneum daemon!  Please go ahead and reboot electroneum with: sudo systemctl restart electroneum as soon as the pool source is updated!"
