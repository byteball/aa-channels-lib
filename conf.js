exports.bServeAsHub = false;
exports.bLight = true;
exports.bSingleAddress = true;

exports.WS_PROTOCOL = "ws://";
exports.hub = process.env.testnet ? 'obyte.org/bb-test' : 'obyte.org/bb';
exports.deviceName = 'AA-channel-lib';
exports.permanent_pairing_secret = '0000';
exports.control_addresses = [''];

exports.aa_version = 1;

exports.isHighAvaibilityNode =  false;

exports.enabledComLayers = ['http','obyte-messenger'];

exports.isHttpServer = false;
exports.httpDefaultPort = 6800;

console.log('finished AA-channel-lib conf');
