FROM "ubuntu:16.04"

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade

RUN DEBIAN_FRONTEND=noninteractive apt-get -y install git curl python-virtualenv python3-virtualenv \
  build-essential libzmq3-dev libboost-all-dev sudo mysql-server && \
  rm -rf /var/lib/apt/lists/*
#   ntp screen cmake pkg-config libevent-dev libunbound-dev \
#   libminiupnpc-dev libunwind8-dev liblzma-dev libldns-dev libexpat1-dev libgtest-dev mysql-server \
#   lmdb-utils libsodium-dev

RUN useradd -ms /bin/bash pool
ENV CURUSER=pool
ENV POOL_DIR=/home/pool
ENV PATH=${PATH}:/home/pool/.nodejs/bin:/home/pool/.bin

ADD deployment/docker/backend/start.bash /home/pool/start.bash
ADD deployment/docker/backend/stack.yml /home/pool/stack.yml

COPY . /home/pool/pool
RUN chown -R pool /home/pool/pool

USER pool
WORKDIR /home/pool

ARG DB_STORAGE_PATH
ARG DB_HOST
ARG DB_NAME
ARG DB_USER
ARG DB_PASS

RUN cd /home/pool/pool/deployment/docker/backend; ./build.bash

ENTRYPOINT /home/pool/start.bash

