# Notes about AEON coin

#### Special considerations for AEON

NodeJS-Pool and PoolUI were built with monero in mind. While a recent update has made the pool compatible with Cryptonight-lite, the UI itself, by another developer, was hardcoded for Monero. Due to this there's a few things that need to be changed for the pool to successfully work.

	- aeond does not have a blockchain import function. So this makes downloading a blockchain.bin and importing it a bit difficult to do. I have included in my deploy.bash script a url i'm providing to keep the blockchain up to date within atleast a week delay, but it's unusable at the moment
	- Until the PoolUI can be updated to allow for coins to be changed via a config, we're going to need to use a separate fork that I'll provide. I'll be working to try to include what I can to make the fork work for Monero AND aeon, but for the purpose here, my main goal will be for Aeon's compatibility.
	- NodeJS-Pool is a bit more complex than CryptoNote Uni Pool, but it appears to be working just fine for our purpsoes. I highly recommend testing it for 1-2blocks if possible.