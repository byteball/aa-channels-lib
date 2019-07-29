"use strict";
const validationUtils = require('ocore/validation_utils.js');
const aaDefinitions = require('./modules/aa_definitions.js');
const eventBus = require('ocore/event_bus.js');
const mutex = require('ocore/mutex.js');
const conf = require('ocore/conf.js');
const objectHash = require('ocore/object_hash.js');
const isUrl = require('is-url');
const crypto = require('crypto');
const correspondents = require('./modules/correspondents.js');
const request = require('request');
const async = require('async');

const REQUEST_TIMEOUT = 8 * 1000;

if (!conf.isHighAvailabilityNode){
	require('./aa_watcher.js');
	var signedMessage = require('ocore/signed_message.js');
	var headlessWallet = require('headless-obyte');
} else {
	var signedMessage = require('./modules/signed_message.js'); // light version that doesn't require DAG DB
}

if (conf.enabledReceivers.includes('obyte-messenger') && conf.isHighAvailabilityNode)
	throw Error("Cannot use obyte-messenger layer as high avaibility node");
if (!validationUtils.isPositiveInteger(conf.minChannelTimeoutInSecond) || !validationUtils.isPositiveInteger(conf.maxChannelTimeoutInSecond))
	throw Error("minChannelTimeoutInSecond and maxChannelTimeoutInSecond in conf.js must be postive integer");

var paymentReceivedCallback;
var assocResponseByTag = {};
var my_address;

if (conf.isHighAvailabilityNode){
	var appDB = require('./modules/external_db.js');
} else {
	var appDB = require('ocore/db.js');
}

if (!conf.isHighAvailabilityNode){ // if another node is used as watcher, it is in charge to create table
	require('./sql/create_sqlite_tables.js');
}


if (conf.isHighAvailabilityNode){
	setTimeout(init, 1000);

} else {
	eventBus.once('headless_wallet_ready', function(){
		setTimeout(init, 1000);
	});
}

async function init(){

	const results = await appDB.query("SELECT my_address FROM channels_config");
	if (results[0])
		my_address = results[0].my_address;
	else
		throw Error("my_address is not defined in app DB, perhaps the cause is that you've never started the watcher node");

	if (conf.enabledReceivers.includes('obyte-messenger')){
		console.log("obyte-messenger receiver enabled");
		eventBus.on('object', function(from_address, receivedObject){
			receivedObject.from_address = from_address;
			if (assocResponseByTag[receivedObject.tag]){
				assocResponseByTag[receivedObject.tag](receivedObject);
				return delete assocResponseByTag[receivedObject.tag];
			}
			return treatIncomingRequest(receivedObject, function(objResponse){
				objResponse.tag = receivedObject.tag;
				objResponse.url = null; // this attribute is reserved for peer url
				const device = require('ocore/device.js');
				return device.sendMessageToDevice(from_address, 'object', objResponse);
			});
		});
	}

	if (conf.enabledReceivers.includes('http') && conf.httpDefaultPort){
		console.log("http receiver enabled");

		const express = require('express')
		const app = express()

		app.use(require('body-parser').json());
		app.post('/post', function(request, response){
			if (typeof request != 'object' || typeof request.body != 'object')
				return response.send({ error: "bad request" });
			else
				treatIncomingRequest(request.body, function(objResponse){
					return response.send(objResponse);
				});
		});
		app.listen(conf.httpDefaultPort);
	}
	if (!conf.isHighAvailabilityNode)
		setInterval(autoRefillChannels, 30000);
}


// treat requests received either by messenger or POST http
async function treatIncomingRequest(objRequest, handle){

	if (objRequest.timestamp < (Date.now() - REQUEST_TIMEOUT / 2))
		return handle({ error: "Timestamp too old, check system time" });
	if (objRequest.command == 'create_channel'){
		if (typeof objRequest.params != "object")
			return handle({ error: "No params" });
		if (!validationUtils.isStringOfLength(objRequest.params.salt, 60))
			return handle({ error: "Invalid salt" });
		if (!validationUtils.isPositiveInteger(objRequest.params.timeout))
			return handle({ error: "Channel timeout must be positive integer" });
		if (objRequest.params.timeout > conf.maxChannelTimeoutInSecond)
			return handle({ error: `Channel timeout is too high, max acceptable: ${conf.maxChannelTimeoutInSecond} seconds`});
		if (objRequest.params.timeout < conf.minChannelTimeoutInSecond)
			return handle({ error: `Channel timeout is too low, min acceptable: ${conf.minChannelTimeoutInSecond} seconds`});
		if (objRequest.params.aa_version > conf.aa_version)
			return handle({ error: "Unsupported aa version" });
		if (!validationUtils.isValidAddress(objRequest.params.address))
			return handle({ error: "Invalid payment address" });
		if (objRequest.params.address == my_address)
			return handle({ error: "this address is not yours" });
		if (objRequest.params.url && !isUrl(objRequest.params.url))
			return handle({ error: "Invalid url" });
		if (objRequest.params.asset != 'base' && !validationUtils.isValidBase64(objRequest.params.asset, 44))
			return handle({ error: "Invalid asset" });
		return createNewChannelOnPeerRequest(objRequest, handle);
	}

	if (objRequest.command == 'pay'){
		if (typeof objRequest.params != "object")
			return handle({ error: "No params" });
		return treatPaymentFromPeer(objRequest, handle);
	}

	if (objRequest.command == 'is_open'){
		if (typeof objRequest.params != "object")
			return handle({ error: "No params" });
		if (!validationUtils.isValidAddress(objRequest.params.aa_address))
			return handle({ error: "Invalid aa address" });
		const channels = await appDB.query("SELECT status FROM channels WHERE aa_address=?", [objRequest.params.aa_address]);
		if (channels.length === 0)
			return handle({ error: "aa address not known" });
		if (channels[0].status == "open" || channels[0].status == "open_confirmed_by_peer")
			return handle({ response: true });
		else
			return handle({ response: false });
	}
}


function treatPaymentFromPeer(objRequest, handle){
	const objSignedPackage = objRequest.params.signed_package;

	signedMessage.validateSignedMessage(objSignedPackage, async (error) => {
		if (error){
			console.error("error when validating message: " + error);
			return handle({ error: error });
		}
		const objSignedMessage = objSignedPackage.signed_message;

		if (typeof objSignedMessage != 'object')
			return handle({ error: "signed message should be an object" });

		if (!validationUtils.isValidAddress(objSignedMessage.channel))
			return handle({ error: "aa address is not valid" });

		mutex.lock([objSignedMessage.channel], async function(unlock){
			function unlockAndHandle(response){
				unlock();
				handle(response);
			}

			const channels = await appDB.query("SELECT * FROM channels WHERE aa_address=?", [objSignedMessage.channel]);
			if (channels.length === 0)
				return unlockAndHandle({ error: "aa address not found" });

			const channel = channels[0];

			if (channel.status == 'closing_initiated_by_me' || channel.status == 'closing_initiated_by_me_acknowledged')
				return unlockAndHandle({ error: "closing initiated by peer", error_code: "closing_initiated_by_peer" });

			if (channel.status != 'open')
				return unlockAndHandle({ error: "channel not open for peer", error_code: "not_open_for_peer" });

			if (channel.period != objSignedMessage.period)
				return unlockAndHandle({ error: "wrong period" });

			if (!validationUtils.isPositiveInteger(objSignedMessage.amount_spent))
				return unlockAndHandle({ error: "amount_spent should be a positive integer" });

			if (!validationUtils.isPositiveInteger(objSignedMessage.payment_amount))
				return unlockAndHandle({ error: "payment_amount should be a positive integer" });

			if (objSignedMessage.authors && objSignedMessage.authors[0] && objSignedMessage.authors[0].address != channel.peer_address)
				return unlockAndHandle({ error: "package signed by wrong address expected : " + channel.peer_address});

			const payment_amount = objSignedMessage.payment_amount;

			if (objSignedMessage.amount_spent > (channel.amount_deposited_by_peer + channel.amount_spent_by_me))
				return unlockAndHandle({ error: "AA not funded enough" });

			const delta_amount_spent = (objSignedMessage.amount_spent - channel.amount_spent_by_peer) > 0 ? (objSignedMessage.amount_spent - channel.amount_spent_by_peer) : 0;
			const peer_credit = delta_amount_spent + channel.credit_attributed_to_peer;

			if (payment_amount > peer_credit)
				return unlockAndHandle({ error: "Payment amount is over your available credit" });

			await appDB.query("UPDATE channels SET amount_spent_by_peer=amount_spent_by_peer+?,last_message_from_peer=?,credit_attributed_to_peer=?\n\
			WHERE aa_address=?", [delta_amount_spent, JSON.stringify(objSignedPackage), peer_credit - payment_amount, channel.aa_address]);
			if (paymentReceivedCallback){
				paymentReceivedCallback(payment_amount, objRequest.params.message, channel.aa_address, function(error, response){
					if (error)
						return unlockAndHandle({ error: error });
					else
						return unlockAndHandle({ response: response });
				});
			} else {
				return unlockAndHandle({ response: "received payment for " + payment_amount });
			}
		});
	});
}



function createNewChannelOnPeerRequest(objRequest, handle){
	const objAAParameters = aaDefinitions.getAddressAndParametersForAA(my_address, objRequest.params.address, objRequest.params.salt, objRequest.params.timeout,objRequest.params.asset);
	appDB.query("INSERT " + appDB.getIgnore() + " INTO channels (asset, timeout,aa_address,salt,peer_address,peer_device_address,peer_url) VALUES (?,?,?,?,?,?,?)",
		[objAAParameters.asset, objAAParameters.timeout, objAAParameters.aa_address, objRequest.params.salt, objRequest.params.address, objRequest.from_address, objRequest.url], function(result){

			if (result.affectedRows !== 1)
				return handle({ error: "this salt already exists" });
			else {
				eventBus.emit("channel_created_by_peer", objRequest.params.address, objAAParameters.aa_address);
				return handle({ response: objAAParameters });
			}

		});
}


function setCallBackForPaymentReceived(_cb){
	paymentReceivedCallback = _cb;
}

async function close(aa_address, handle){
	if (!conf.isHighAvailabilityNode){
		const channels = await appDB.query("SELECT amount_spent_by_peer,amount_spent_by_me,last_message_from_peer, period, credit_attributed_to_peer FROM channels WHERE aa_address=?", [aa_address]);
		if (channels.length === 0)
			return handle("unknown AA address");
		const channel = channels[0];
		const composer = require('ocore/composer.js');
		const network = require('ocore/network.js');
		const callbacks = composer.getSavingCallbacks({
			ifNotEnoughFunds: () => {
				handle("not enough fund to close channel");
			},
			ifError: (error) => {
				handle("error when closing channel " + error);
			},
			preCommitCb: function(conn, objJoint, cb){
				conn.query("UPDATE channels SET status='closing_initiated_by_me' WHERE aa_address=?", [aa_address]);
				cb();
			},
			ifOk: function(objJoint){
				network.broadcastJoint(objJoint);
				handle(null);
			}
		})

		const payload = { close: 1, period: channel.period };
		if (channel.amount_spent_by_me + channel.credit_attributed_to_peer > 0)
			payload.transferredFromMe = channel.amount_spent_by_me + channel.credit_attributed_to_peer;
		if (channel.amount_spent_by_peer > 0)
			payload.sentByPeer = JSON.parse(channel.last_message_from_peer);

		const objMessage = {
			app: 'data',
			payload_location: "inline",
			payload_hash: objectHash.getBase64Hash(payload),
			payload: payload
		};

		composer.composeJoint({
			paying_addresses: [my_address],
			outputs: [{ address: my_address, amount: 0 }, { address: aa_address, amount: 10000 }],
			signer: headlessWallet.signer,
			messages: [objMessage],
			callbacks: callbacks
		});
	} else {
		//order aa watcher to close channel
		const result = await appDB.query("UPDATE channels SET closing_authored=1 FROM channels WHERE aa_address=?", [aa_address]);
		if (result.affectedRows !== 1)
			return handle("aa address not known");
		else
			return handle(null);
	}
}


function deposit(aa_address, amount, handle){
	if (conf.isHighAvailabilityNode)
		return handle("high availability node can only receive funds");
	if (!validationUtils.isPositiveInteger(amount))
		return handle("amount must be positive integer");

	mutex.lock([aa_address], async function(unlock){
		const channels = await appDB.query("SELECT status,asset FROM channels WHERE aa_address=?", [aa_address]);
		if (channels.length != 1){
			unlock();
			return handle("unknown channel");
		}

		const channel = channels[0];
		if (channel.asset == "base" && amount < 1e5){
			unlock();
			return handle("amount must be >= 1e5");
		}
		if (channel.status != "open" && channel.status != "open_confirmed_by_peer" && channel.status != "closed" && channel.status != "created"){
			unlock();
			return handle("channel status: " + channel.status + ", no deposit possible");
		}
		const options = {
			asset: channel.asset,
			change_address: my_address,
		}

		if (channel.asset == 'base')
			options.base_outputs = [{ address: aa_address, amount: amount }];
		else {
			options.asset_outputs = [{ address: aa_address, amount: amount }];
			options.base_outputs = [{ address: aa_address, amount: 10000 }];
		}
		headlessWallet.sendMultiPayment(options, function(error, unit){
			if (error)
			return handle("error when deposit to channel " + error);
			appDB.query("INSERT INTO pending_deposits (unit, amount, aa_address) VALUES (?, ?, ?)", [unit, amount, aa_address]);
			unlock();
			handle(null);
		});
	});
}


function createNewChannel(peer, initial_amount, options, handle){
	options = options || {};
	if (conf.isHighAvailabilityNode)
		return handle("high availability node cannot create channel");
	if (!my_address)
		return handle("not initialized");
	if (!validationUtils.isPositiveInteger(initial_amount))
		return handle("amount must be positive integer");
	if (options.timeout && !validationUtils.isPositiveInteger(options.timeout))
		return handle("timeout must be a positive integer");
	if (options.asset && !validationUtils.isValidBase64(options.asset,44))
		return handle("asset is not valid");
	if (!options.asset && initial_amount <= 1e5)
		return handle("initial_amount must be > 1e5");
	if (options.auto_refill_threshold && !validationUtils.isPositiveInteger(options.auto_refill_threshold))
		return handle("auto_refill_threshold must be positive integer");
	if (options.auto_refill_amount && !validationUtils.isPositiveInteger(options.auto_refill_threshold))
		return handle("auto_refill_threshold must be positive integer");
	
	const asset = options.asset || 'base';
	const salt = crypto.randomBytes(30).toString('hex');
	let matches = peer.match(/^([\w\/+]+)@([\w.:\/-]+)#([\w\/+-]+)$/);

	const objToBeSent = {
		command: "create_channel",
		params: {
			salt: salt,
			address: my_address,
			timeout: options.timeout || conf.defaultTimeoutInSecond,
			asset: asset
		}
	}
	const responseCb = function(responseFromPeer){
		treatResponseToChannelCreation(responseFromPeer, function(error, response){
			if (error)
				return handle(error);
			return handle(null, response);
		});
	}

	if (matches){ //it's a pairing address
		if (conf.isHighAvailabilityNode)
			return handle("pairing address cannot be used in high availability mode");
		var correspondent_address;
		var peer_url;
		correspondents.findCorrespondentByPairingCode(peer, (correspondent) => {
			if (!correspondent){
				correspondents.addCorrespondent(peer, 'Payment channel peer', (err, device_address) => {
					if (err)
						return handle(err);
					correspondent_address = device_address;
					sendRequestToPeer("obyte-messenger", correspondent_address, objToBeSent, responseCb)
				});
			} else {
				correspondent_address = correspondent.device_address
				sendRequestToPeer("obyte-messenger", correspondent_address, objToBeSent, responseCb)
			}
		});
	} else if (isUrl(peer)){
		peer_url = peer.substr(-1) == "/" ? peer : peer + "/";
		sendRequestToPeer("http", peer, objToBeSent, responseCb)
	} else {
		return handle("not url nor pairing address provided");
	}

	async function treatResponseToChannelCreation(responseFromPeer, handle){
		if (responseFromPeer.error)
			return handle(responseFromPeer.error);
		if (typeof responseFromPeer.response != 'object')
			return handle('bad response from peer');
		const response = responseFromPeer.response;
		if (!validationUtils.isValidAddress(response.address_a))
			return handle('address a is incorrect')
		if (my_address == response.address_a)
			return handle({ error: "this address is not yours" });
		if (my_address != response.address_b)
			return handle('address b is not mine');
		const objCalculatedAAParameters = aaDefinitions.getAddressAndParametersForAA(response.address_a, my_address, salt, options.timeout, asset);
		if (objCalculatedAAParameters.aa_address !== response.aa_address)
			return handle('peer calculated different aa address');

		const result = await appDB.query("INSERT " + appDB.getIgnore() + " INTO channels \n\
		(auto_refill_threshold,auto_refill_amount, asset, timeout,aa_address,salt,peer_address,peer_device_address,peer_url) \n\
		VALUES (?,?,?,?,?,?,?,?,?)",
		[options.auto_refill_threshold, options.auto_refill_amount, asset, options.timeout, response.aa_address, salt, response.address_a, correspondent_address || null, peer_url || null]);
		if (result.affectedRows !== 1)
			return handle("this salt already exists");
		else {
			sendDefinitionAndDepositToChannel(response.aa_address, objCalculatedAAParameters.arrDefinition, initial_amount, asset).then(() => {
				return handle(null, response.aa_address);
			}, (error) => {
				return handle(error);
			});
		}
	}
}

function askIfChannelOpen(comLayer, peer, aa_address){
	return new Promise((resolve, reject) => {
		const objToBeSent = {
			command: "is_open",
			timestamp: Date.now(),
			params: {
				aa_address: aa_address
			}
		}
		const responseCb = async function(responseFromPeer){
			return resolve(responseFromPeer.response);
		}

		const timeOutCb = function(){
			return resolve(false);
		};
		sendRequestToPeer(comLayer, peer, objToBeSent, responseCb, timeOutCb);
	});
}

function sendMessageAndPay(aa_address, message, payment_amount, handle){
	if (conf.isHighAvailabilityNode)
		return handle("high availability node can only receive payment");
	if (!my_address)
		return handle("not initialized");
	mutex.lock([aa_address], async function(unlock){

		function unlockAndHandle(error, response){
			unlock();
			handle(error, response);
		}
		const channels = await appDB.query("SELECT status,period,peer_device_address,peer_url,amount_deposited_by_me,amount_spent_by_peer,amount_spent_by_me FROM channels WHERE aa_address=?", [aa_address]);

		if (channels.length === 0)
			return unlockAndHandle("AA address not found");

		const channel = channels[0];

		if (channel.peer_device_address && conf.isHighAvailabilityNode)
			return unlockAndHandle("device address cannot be used in high availability mode");

		if (channel.status != "open" && channel.status != "open_confirmed_by_peer")
			return unlockAndHandle("Channel is not open");

		const myFreeAmountOnAA = channel.amount_deposited_by_me - channel.amount_spent_by_me + channel.amount_spent_by_peer;

		if (payment_amount > myFreeAmountOnAA)
			return unlockAndHandle("AA not funded enough");

		const comLayer = channel.peer_device_address ? "obyte-messenger" : "http";
		const peer = channel.peer_device_address || channel.peer_url;

		if (channel.status != "open_confirmed_by_peer"){
			if (await askIfChannelOpen(comLayer, peer, aa_address))
				await appDB.query("UPDATE channels SET status='open_confirmed_by_peer' WHERE aa_address=?", [aa_address]);
			else
				return unlockAndHandle("Channel is not open for peer");
		}

		const objSignedPackage = await signMessage({ payment_amount: payment_amount, amount_spent: (payment_amount + channel.amount_spent_by_me), period: channel.period, channel: aa_address }, my_address);

		const objToBeSent = {
			command: "pay",
			timestamp: Date.now(),
			params: {
				signed_package: objSignedPackage,
				message: message
			}
		}
		const responseCb = async function(responseFromPeer){
			if (responseFromPeer.error){
				await appDB.query("UPDATE channels SET amount_possibly_lost_by_me=amount_possibly_lost_by_me+? WHERE aa_address=?", [payment_amount, aa_address]);
				if (responseFromPeer.error_code == "closing_initiated_by_peer")
					await appDB.query("UPDATE channels SET status='closing_initiated_by_peer' WHERE aa_address=?", [aa_address]);
				return unlockAndHandle(responseFromPeer.error);
			}
			if (!responseFromPeer.response)
				return unlockAndHandle('bad response from peer');
			return unlockAndHandle(null, responseFromPeer.response);
		}

		const timeOutCb = function(){
			return unlockAndHandle('no response from peer');
		};

		await appDB.query("UPDATE channels SET amount_spent_by_me=amount_spent_by_me+? WHERE aa_address=?", [payment_amount, aa_address]);
		sendRequestToPeer(comLayer, peer, objToBeSent, responseCb, timeOutCb);

	});
}

function signMessage(message, address){
	return new Promise((resolve, reject) => {
		signedMessage.signMessage(message, address, headlessWallet.signer, false, function(err, objSignedPackage){
			if (err)
				return reject(err);
			resolve(objSignedPackage);
		});
	});
}


function sendRequestToPeer(comLayer, peer, objToBeSent, responseCb, timeOutCb){
	const tag = crypto.randomBytes(30).toString('hex');
	assocResponseByTag[tag] = responseCb;
	objToBeSent.tag = tag;
	if (comLayer == "obyte-messenger"){
		if (conf.isHighAvailabilityNode)
			throw Error("obyte messenger no available in high avaibility mode");
		const device = require('ocore/device.js');
		device.sendMessageToDevice(peer, 'object', objToBeSent);
	} else if (comLayer == "http"){
		request.post(peer + "post", {
			json: objToBeSent
		}, (error, res, body) => {
			if (error || res.statusCode != 200){
				return console.error("error in response from peer: " + peer + " " + JSON.stringify(res));
			}
			if (assocResponseByTag[tag]) //if timeout not reached
				delete assocResponseByTag[tag];
			responseCb(body);
		});
	}

	if (timeOutCb)
		setTimeout(function(){
			if (assocResponseByTag[tag]){
				timeOutCb();
				delete assocResponseByTag[tag];
			}
		}, REQUEST_TIMEOUT);
}


function sendDefinitionAndDepositToChannel(aa_address, arrDefinition, filling_amount, asset){
	return new Promise(async (resolve, reject) => {
		const payload = { address: aa_address, definition: arrDefinition };

		const options = {
			messages: [{
				app: 'definition',
				payload_location: "inline",
				payload_hash: objectHash.getBase64Hash(payload),
				payload: payload
			}],
			asset: asset,
			change_address: my_address,
		}

		if (asset == 'base')
			options.base_outputs = [{ address: aa_address, amount: filling_amount }];
		else {
			options.asset_outputs = [{ address: aa_address, amount: filling_amount }];
			options.base_outputs = [{ address: aa_address, amount: 10000 }];

		}
		headlessWallet.sendMultiPayment(options, function(error, unit){
			if (error)
				reject("error when creating channel " + error);
			appDB.query("INSERT INTO pending_deposits (unit, amount, aa_address) VALUES (?, ?, ?)", [unit, filling_amount, aa_address]);
			resolve();
		});

	});
}

function autoRefillChannels(){
	mutex.lock(["autoRefillChannels"], async function(unlock){
		const rows = await appDB.query("SELECT channels.aa_address, auto_refill_threshold, auto_refill_amount, (amount_deposited_by_me - amount_spent_by_me + amount_spent_by_peer) AS free_amount,\n\
		IFNULL((SELECT SUM(amount) FROM pending_deposits WHERE pending_deposits.aa_address=channels.aa_address AND is_confirmed_by_aa=0),0) AS pending_amount\n\
		FROM channels WHERE (free_amount + pending_amount) < auto_refill_threshold"); //pending deposits are taken into account when comparing with auto_refill_threshold
		async.eachSeries(rows, function(row, cb){
			deposit(row.aa_address, row.auto_refill_amount, function(error){
				if (error)
					console.log("error when auto refill " + error);
				else {
					console.log("channel " + row.aa_address + " refilled with " + row.auto_refill_amount + " bytes");
					eventBus.emit("channel_refilled", row.aa_address, row.auto_refill_amount);
					return cb();
				}
			});
		}, function(){
			unlock();
		});
	});
}

async function setAutoRefill(aa_address, refill_amount, refill_threshold, handle){
	const result = await appDB.query("UPDATE channels SET auto_refill_threshold=?,auto_refill_amount=? WHERE aa_address=?", [refill_threshold, refill_amount, aa_address]);
	if (result.affectedRows !== 1)
		return handle("aa_address not known");
	else
		return handle(null);
}

async function getBalancesAndStatus(aa_address, handle){
	const rows = await appDB.query("SELECT status,amount_deposited_by_me,amount_spent_by_me, amount_spent_by_peer, (amount_deposited_by_me - amount_spent_by_me + amount_spent_by_peer) AS free_amount,\n\
	IFNULL((SELECT SUM(amount) FROM pending_deposits WHERE pending_deposits.aa_address=channels.aa_address AND is_confirmed_by_aa=0),0) AS pending_deposits\n\
	FROM channels WHERE channels.aa_address=?", [aa_address]);
	if (rows.length === 0)
		return handle("aa_address not known");
	else
		return handle(null, rows[0]);

}


exports.setAutoRefill = setAutoRefill;
exports.createNewChannel = createNewChannel;
exports.deposit = deposit;
exports.sendMessageAndPay = sendMessageAndPay;
exports.close = close;
exports.setCallBackForPaymentReceived = setCallBackForPaymentReceived;
exports.getBalancesAndStatus = getBalancesAndStatus;