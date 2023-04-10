#!/usr/bin/env bash

set -e

TMP=$(mktemp -d)

cd $TMP
git clone -b sb-app-cache-fix https://github.com/tari-project/poolui.git poolui
cd $TMP/poolui
npm install
npx bower update --allow-root
npx gulp build
ls
mv build /build
