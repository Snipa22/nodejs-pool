FROM ubuntu:18.04 as build

RUN apt-get update && apt-get install -y curl
RUN cd /tmp && curl -L https://downloads.getmonero.org/cli/monero-linux-x64-v0.17.1.6.tar.bz2 -o monero.tar.gz && \
  cd /tmp && mkdir /monero && tar -xjf monero.tar.gz -C /monero && cd /monero && mv monero-x86_64-linux-gnu-v0.17.1.6/* .

# COPY monero.tar.gz /tmp

FROM ubuntu:18.04

COPY --from=build /monero /monero

RUN useradd -ms /bin/bash monero
USER monero
RUN if [ -d /home/monero/monero-blockchain ]; then monero-blockchain-import /home/monero/monero-blockchain/blockchain.raw; fi

WORKDIR /monero
ENTRYPOINT /monero/monerod



