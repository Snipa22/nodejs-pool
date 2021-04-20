#!/bin/bash

subject=$1
body=$2

if [ -z "$subject" ]; then echo "Set subject as first script parameter"; exit 1; fi
if [ -z "$body" ]; then echo "Set body as second script parameter"; exit 1; fi

node cache_set.js --key=news --value='{"created": "'$(date +%s)'", "subject": "'"$subject"'", "body": "'"$body"'"}'
