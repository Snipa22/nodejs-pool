#!/bin/bash
cd ~
git clone https://github.com/Venemo/node-lmdb.git
cd node-lmdb
git checkout v0.7.0
cd dependencies/lmdb/libraries/liblmdb
make -j `nproc`
mkdir ~/.bin
echo ' ' >> ~/.bashrc
echo 'export PATH=~/.bin:$PATH' >> ~/.bashrc
for i in mdb_copy mdb_dump mdb_load mdb_stat; do cp $i ~/.bin/; done
echo "Please run source ~/.bashrc to initialize the new LMDB tools.  Thanks for flying Snipa22 Patch Services."