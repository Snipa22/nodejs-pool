#!/usr/bin/env bash

set -e

if [ "$#" -gt 0 ]; then
  pm2 start ./deployment/docker/backend/stack.yml --only "$@"
else
  pm2 start ./deployment/docker/backend/stack.yml
fi
