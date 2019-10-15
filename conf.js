exports.bServeAsHub = false;
exports.bLight = true;
exports.bSingleAddress = true; // should always be true!

exports.WS_PROTOCOL = "ws://";
exports.hub = process.env.testnet ? 'obyte.org/bb-test' : 'obyte.org/bb';
exports.deviceName = 'AA-channel-lib';
exports.permanent_pairing_secret = '0000';
exports.control_addresses = [''];

exports.minChannelTimeoutInSeconds = 800; // minimal channel timeout acceptable
exports.maxChannelTimeoutInSeconds = 1500;  // maximal channel timeout acceptable
exports.defaultTimeoutInSecond = 1000; // default timeout for channel creation

exports.isHighAvailabilityNode =  false;

exports.unconfirmedAmountsLimitsByAssetOrChannel = { // limits for accepting payments backed by unconfirmed deposit from peer
	"base" : {
		max_unconfirmed_by_asset : 1e6,
		max_unconfirmed_by_channel : 1e6,
		minimum_time_in_second : 5
	}
}

exports.enabledReceivers = ['http','obyte-messenger']; //configure the communication layers that can receive a message from peer
// if 'http' is present, a http server will start to listen at port httpDefaultPort
// if 'obyte-messenger' is present, messages incoming through the encypted chat layers will be treated (not possible in High availability mode)

exports.httpDefaultPort = 6800;

console.log('finished AA-channel-lib conf');
