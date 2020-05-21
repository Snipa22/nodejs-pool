#!/bin/bash

subject=$1
body=$2

if [ -z "$subject" ]; then echo "Set subject as first script paaameter"; exit 1; fi
if [ -z "$body" ]; then echo "Set bosy as second script paaameter"; exit 1; fi

node cache_set.js --key=news --value='{"created": "'$(date +%s)'", "subject": "'$subject'", "body": "'$body'"}'