const objectHash = require('ocore/object_hash.js');


const DEFAULT_VERSION = "1.0";

const BASE_AA_BY_VERSION = {
	"1.0": "SDFSAPTYVHQ6IUNJ6NYEHH2PL544AWLQ"
}

function doesAaVersionExist(version){
	return !!BASE_AA_BY_VERSION[version];
}

function getDefaultVersion(){
	return DEFAULT_VERSION;
}

function getAaAddress(addressA, addressB, timeout, asset, salt, version){
	return objectHash.getChash160( getAaArrDefinition(addressA, addressB, timeout, asset, salt, version));
}


function getAaArrDefinition(addressA, addressB, timeout, asset, salt, version){
	const base_aa = version ? BASE_AA_BY_VERSION[version] : BASE_AA_BY_VERSION[DEFAULT_VERSION];
	return ['autonomous agent', 
		{
			base_aa: base_aa,
			params:	{
				addressA,
				addressB,
				asset,
				salt,
				timeout
			}
		}
	]
}
exports.getAaAddress = getAaAddress;
exports.getAaArrDefinition = getAaArrDefinition;
exports.doesAaVersionExist = doesAaVersionExist;
exports.getDefaultVersion = getDefaultVersion;