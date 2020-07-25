const objectHash = require('ocore/object_hash.js');

const BASE_AA = "SDFSAPTYVHQ6IUNJ6NYEHH2PL544AWLQ";

function getAaAddress(addressA, addressB, timeout, asset, salt){
	return objectHash.getChash160( getAaArrDefinition(addressA, addressB, timeout, asset, salt));
}


function getAaArrDefinition(addressA, addressB, timeout, asset, salt){
	return ['autonomous agent', 
		{
			base_aa: BASE_AA,
			params:	{
				asset,
				addressA,
				addressB,
				asset,
				salt
			}
		}
	]
}
exports.getAaAddress = getAaAddress;
exports.getAaArrDefinition = getAaArrDefinition;