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
		console.error("headless_wallet_ready front");

		setTimeout(init, 1000);
	});
}

async function init(){

	const results = await appDB.query("SELECT my_address FROM channels_config");
	console.error("results front");

	if (results[0])
		my_address = results[0].my_address;
	else
		throw Error("my_address is not defined in app DB, perhaps the cause is that you've never started the watcher node");
console.error("my_address: " + my_address);
	if (conf.enabledReceivers.includes('obyte-messenger')){
		console.log("obyte-messenger receiver enabled");
		eventBus.on('object', function(from_address, receivedObject){
			receivedObject.from_address = from_address;
			if (assocResponseByTag[receivedObject.tag]){
				assocResponseByTag[receivedObject.tag](receivedObject);
				return delete assocResponseByTag[receivedObject.tag];
			}
			return treatIncomingRequest(receivedObject, function(objResponse){
				if (!conf.giveAndExpectResponse)
					return;
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
					if (conf.giveAndExpectResponse)
						return response.send(objResponse);
					else
						return response.send();
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

		saveChannelCreatedByPeer(objRequest.params, function(error, result){
			if (error)
				return handle({ error: error });
			else
				return handle({ response: result });
		});
	}

	if (objRequest.command == 'pay'){
		if (typeof objRequest.params != "object")
			return handle({ error: "No params" });
		if (typeof objRequest.params.signed_package != "object")
			return handle({ error: "No signed_package" });

		return treatPaymentFromPeer(objRequest.params.signed_package, function(error, result){
			console.error(result);

			if (error)
				return handle({ error: error });
			else
				return handle({ response: result });
		});
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


function treatPaymentFromPeer(objSignedPackage, handle){

	verifyPaymentPackage(objSignedPackage, function(error, payment_amount, aa_address){
		if (paymentReceivedCallback){
			paymentReceivedCallback(payment_amount, objRequest.params.message, aa_address, function(error, response){
				if (error)
					return handle(error);
				else
					return handle(null, response);
			});
		} else {
			return handle(null, "received payment for " + payment_amount );
		}
	});
}


function saveChannelCreatedByPeer(objParams, handle){

if (objParams.salt && !validationUtils.isNonemptyString(objParams.salt))
	return handle("Salt must be string");
if (objParams.salt && objParams.salt.length > 50)
	return handle("Salt must be 50 char max");
if (!validationUtils.isPositiveInteger(objParams.timeout))
	return handle("Channel timeout must be positive integer");
if (objParams.timeout > conf.maxChannelTimeoutInSecond)
	return handle(`Channel timeout is too high, max acceptable: ${conf.maxChannelTimeoutInSecond} seconds`);
if (objParams.timeout < conf.minChannelTimeoutInSecond)
	return handle(`Channel timeout is too low, min acceptable: ${conf.minChannelTimeoutInSecond} seconds`);
if (objParams.aa_version > conf.aa_version)
	return handle("Unsupported aa version");
if (!validationUtils.isValidAddress(objParams.address))
	return handle("Invalid payment address");
if (objParams.address == my_address)
	return handle("this address is not yours");
if (objParams.url && !isUrl(objParams.url))
	return handle("Invalid url");
if (objParams.asset != 'base' && !validationUtils.isValidBase64(objParams.asset, 44))
	return handle("Invalid asset");

	const aa_address = aaDefinitions.getAaAddress(my_address, objParams.address,objParams.timeout ,objParams.asset, objParams.salt);
	appDB.query("INSERT " + appDB.getIgnore() + " INTO channels (asset, timeout,aa_address,salt,peer_address,peer_device_address,peer_url) VALUES (?,?,?,?,?,?,?)",
	[objParams.asset, objParams.timeout, aa_address, objParams.salt, objParams.address, objRequest.from_address, objRequest.url], function(result){
		if (result.affectedRows !== 1)
			return handle("this salt already exists");
		else {
			eventBus.emit("channel_created_by_peer", objParams.address, aa_address);
			return handle(null, aa_address);
		}
	});
}


function setCallBackForPaymentReceived(_cb){
	paymentReceivedCallback = _cb;
}

async function close(aa_address, handle){
	if (!conf.isHighAvailabilityNode){
		const channels = await appDB.query("SELECT amount_spent_by_peer,amount_spent_by_me,last_message_from_peer, period, overpayment_from_peer FROM channels WHERE aa_address=?", [aa_address]);
		if (channels.length === 0)
			return handle("unknown AA address");
		const channel = channels[0];

		const payload = { close: 1, period: channel.period };
		if (channel.amount_spent_by_me + channel.overpayment_from_peer > 0)
			payload.transferredFromMe = channel.amount_spent_by_me + channel.overpayment_from_peer;
		if (channel.amount_spent_by_peer > 0)
			payload.sentByPeer = JSON.parse(channel.last_message_from_peer);

		const options = {
			messages: [{
				app: 'data',
				payload_location: "inline",
				payload_hash: objectHash.getBase64Hash(payload),
				payload: payload
			}],
			change_address: my_address,
			base_outputs: [{ address: aa_address, amount: 10000 }]
		}

		headlessWallet.sendMultiPayment(options, function(error, unit){
			if (error)
				handle("error when closing channel " + error);
			else
				appDB.query("UPDATE channels SET status='closing_initiated_by_me' WHERE aa_address=?", [aa_address]);

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
		headlessWallet.sendMultiPayment(options, async function(error, unit){
			if (error){
				unlock();
				return handle("error when deposit to channel " + error);
			} else{
				await appDB.query("INSERT INTO pending_deposits (unit, amount, aa_address) VALUES (?, ?, ?)", [unit, amount, aa_address]);
				unlock();
				return handle(null);
			}
		});
	});
}


function createNewChannel(peer, initial_amount, options, handle){
	options = options || {};
	if (conf.isHighAvailabilityNode)
		return handle("high availability node cannot create channel");
	if (!my_address)
		return handle("not initialized");
	if (peer && !validationUtils.isNonemptyString(peer))
		return handle("peer must be string");
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
	if (validationUtils.isNonemptyString(options.salt) && options.salt.length > 50)
		return handle("Salt must be 50 char max");
	if (!conf.giveAndExpectResponse && !validationUtils.isValidAddress(options.peer_address))
		return handle( "peer_address is not valid");

	const asset = options.asset || 'base';

	if (validationUtils.isNonemptyString(options.salt))
		var salt = options.salt;
	else if (options.salt === true)
		var salt = crypto.randomBytes(25).toString('hex');
	else
		var salt = null;

	var correspondent_address;
	var peer_url;

	let matches = peer.match(/^([\w\/+]+)@([\w.:\/-]+)#([\w\/+-]+)$/);
	if (matches){ //it's a pairing address
		if (conf.isHighAvailabilityNode)
			return handle("pairing address cannot be used in high availability mode");
		correspondents.findOrAddCorrespondentByPairingCode(peer, function (error, correspondent){
			if (error)
				return console.log("error when looking for correspondent: " + error);
			correspondent_address = correspondent;
		});
		if (!correspondent_address)
			return handle("couldn't pair with device");
	} else if (isUrl(peer)){
		peer_url = peer.substr(-1) == "/" ? peer : peer + "/";
	} else if(conf.giveAndExpectResponse){
		return handle("giveAndExpectResponse set to true but no peer specified");
	}

	if (conf.giveAndExpectResponse){ //if we expect response, channel is created after confirmation from peer
		var responseCb = function(responseFromPeer){
			treatResponseToChannelCreation(responseFromPeer, function(error, response){
				if (error)
					return handle(error);
				return handle(null, response);
			});
		}
	} else { //if no response expected, channel is created immediately
		const aa_address = aaDefinitions.getAaAddress(options.peer_address, my_address, options.timeout, asset, salt);
		const arrAaDefinition = aaDefinitions.getAaArrDefinition(options.peer_address, my_address, options.timeout, asset, salt);
		return createChannelAndSendDefinitionAndDeposit(initial_amount, arrAaDefinition, options.auto_refill_threshold, options.auto_refill_amount, asset, 
		options.timeout, aa_address, salt, options.peer_address, correspondent_address || null, peer_url || null, handle);
	}

	const objToBeSent = {
		command: "create_channel",
		params: {
			address: my_address,
			timeout: options.timeout || conf.defaultTimeoutInSecond,
			asset: asset
		}
	}

	if (salt)
		objToBeSent.params.salt = salt;
		
	if (correspondent_address)
		sendRequestToPeer("obyte-messenger", correspondent_address, objToBeSent, responseCb);
	else if (peer_url)
		sendRequestToPeer("http", peer, objToBeSent, responseCb);
	else
		throw Error("no correspondent_address nor peer_url");

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
		const calculated_aa_address = aaDefinitions.getAaAddress(response.address_a, my_address, options.timeout, asset, salt);
		if (calculated_aa_address !== response.aa_address)
			return handle('peer calculated different aa address');
		const arrAaDefinition = aaDefinitions.getAaArrDefinition(response.address_a, my_address, options.timeout, asset, salt)
		createChannelAndSendDefinitionAndDeposit(initial_amount, arrAaDefinition, options.auto_refill_threshold, options.auto_refill_amount, asset, 
		options.timeout, response.aa_address, salt, response.address_a, correspondent_address || null, peer_url || null, handle);
	}
	
}

async function createChannelAndSendDefinitionAndDeposit(initial_amount, arrDefinition, auto_refill_threshold, auto_refill_amount, asset, timeout, aa_address, salt, peer_address, peer_device_address, peer_url, handle){
	const result = await appDB.query("INSERT " + appDB.getIgnore() + " INTO channels \n\
		(auto_refill_threshold,auto_refill_amount, asset, timeout,aa_address,salt,peer_address,peer_device_address,peer_url) \n\
		VALUES (?,?,?,?,?,?,?,?,?)",
		[auto_refill_threshold, auto_refill_amount, asset, timeout, aa_address, salt, peer_address, peer_device_address, peer_url]);
	if (result.affectedRows !== 1)
		return handle("this salt already exists");
	else {
		sendDefinitionAndDepositToChannel(aa_address, arrDefinition, initial_amount, asset).then(() => {
			return handle(null, aa_address);
		}, (error) => {
			return handle(error);
		});
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

	getPaymentPackage(payment_amount, true, aa_address, function(error, objSignedPackage, peer, comLayer){
		if (error)
			return handle(error);

		const objToBeSent = {
			command: "pay",
			timestamp: Date.now(),
			params: {
				signed_package: objSignedPackage,
				message: message
			}
		}
		const responseCb = async function(responseFromPeer){
			if (typeof responseFromPeer != 'object')
				return handle("wrong response from peer");
			if (responseFromPeer.error){
				await appDB.query("UPDATE channels SET amount_possibly_lost_by_me=amount_possibly_lost_by_me+? WHERE aa_address=?", [payment_amount, aa_address]);
				if (responseFromPeer.error_code == "closing_initiated_by_peer")
					await appDB.query("UPDATE channels SET status='closing_initiated_by_peer' WHERE aa_address=?", [aa_address]);
				return handle(responseFromPeer.error);
			}
			if (!responseFromPeer.response)
				return handle('bad response from peer');
			return handle(null, responseFromPeer.response);
		}

		const timeOutCb = function(){
			return handle('no response from peer');
		};

		sendRequestToPeer(comLayer, peer, objToBeSent, responseCb, timeOutCb);
	})
	
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
	if (conf.giveAndExpectResponse)
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
				return console.log("error in response from peer: " + peer + " " + JSON.stringify(res));
			}
			if (assocResponseByTag[tag]) //if timeout not reached
				delete assocResponseByTag[tag];
			if (conf.giveAndExpectResponse)
				responseCb(body);
		});
	}

	if (timeOutCb && conf.giveAndExpectResponse)
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
		headlessWallet.sendMultiPayment(options, async function(error, unit){
			if (error)
				reject("error when creating channel " + error);
			else
				await appDB.query("INSERT INTO pending_deposits (unit, amount, aa_address) VALUES (?, ?, ?)", [unit, filling_amount, aa_address]);
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


function getPaymentPackage(payment_amount, bReachablePeer, options, handle){

	if (!my_address)
		return handle("not initialized");

	if (!validationUtils.isValidAddress(options)){
		if (typeof options != 'object')
			return handle("options should be an aa address or an object");
		if (validationUtils.isNonemptyString(options.salt) && options.salt.length > 50)
			return handle({ error: "Salt must be 50 char max" });
		if (options.timeout && !validationUtils.isPositiveInteger(options.timeout))
			return handle("timeout must be a positive integer");
		if (options.asset && !validationUtils.isValidBase64(options.asset,44))
			return handle("asset is not valid");
		if (!validationUtils.isValidAddress(options.peer_address))
			return handle("peer_address is not a valid address");
		options.asset = options.asset || 'base';
		var aa_address = aaDefinitions.getAaAddress(my_address, options.peer_address, options.timeout,options.asset, options.salt);

	} else {
		var aa_address = options;
		options = null;
	}

	mutex.lock([aa_address], async function(unlock){

		function unlockAndHandle(error, response, peer, comLayer){
			unlock();
			handle(error, response, peer, comLayer);
		}

		if (!my_address)
		return unlockAndHandle("not initialized");

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

		var peer, comLayer;
		if(bReachablePeer){
			peer = channel.peer_device_address || channel.peer_url;
			if (peer){ // if we have a way to query the peer, we check that it sees channel open as well
				comLayer = channel.peer_device_address ? "obyte-messenger" : "http";

				if (channel.status != "open_confirmed_by_peer" && conf.giveAndExpectResponse){
					if (await askIfChannelOpen(comLayer, peer, aa_address))
						await appDB.query("UPDATE channels SET status='open_confirmed_by_peer' WHERE aa_address=?", [aa_address]);
					else
						return unlockAndHandle("Channel is not open for peer");
				}
			} else{
				return unlockAndHandle("no com layer for peer");
			}
		}
		await appDB.query("UPDATE channels SET amount_spent_by_me=amount_spent_by_me+? WHERE aa_address=?", [payment_amount, aa_address]);

		const objSignedPackage = await signMessage({ 
			payment_amount: payment_amount, 
			amount_spent: (payment_amount + channel.amount_spent_by_me), 
			period: channel.period, 
			aa_address: aa_address 
		}, my_address);

		unlockAndHandle(null, objSignedPackage, peer, comLayer);

	});
}

function verifyPaymentPackage(objSignedPackage, handle){

	signedMessage.validateSignedMessage(objSignedPackage, async (error) => {
		if (error){
			console.log("error when validating message: " + error);
			return handle( error);
		}
		const objSignedMessage = objSignedPackage.signed_message;

		if (typeof objSignedMessage != 'object')
			return handle("signed message should be an object");

		if (objSignedMessage.aa_address && !validationUtils.isValidAddress(objSignedMessage.aa_address))
			return handle("aa address is not valid");

		if (!validationUtils.isPositiveInteger(objSignedMessage.amount_spent))
			return handle("amount_spent should be a positive integer");
		if (!validationUtils.isPositiveInteger(objSignedMessage.payment_amount))
			return handle("payment_amount should be a positive integer");

		const channels = await appDB.query("SELECT peer_address FROM channels WHERE aa_address=?", [objSignedMessage.aa_address]);

		if (!channels[0])
			return handle( "unknown channel");

		if (!objSignedPackage.authors || !objSignedPackage.authors[0] || objSignedPackage.authors[0].address != channels[0].peer_address)
			return handle( "package signed by wrong address expected : " + channels[0].peer_address);

		const payment_amount = objSignedMessage.payment_amount;

		appDB.takeConnectionFromPool(async function(conn) {
			mutex.lock([objSignedMessage.aa_address], async function(unlock){
				async function unlockAndHandle(error, payment_amount, aa_address){
					if (conf.isHighAvailabilityNode){
						await	conn.query("DO RELEASE_LOCK(?)",[objSignedMessage.aa_address]);
					}
					unlock();
					handle(error, payment_amount, aa_address);
				}

				if (conf.isHighAvailabilityNode){
					const results = await	conn.query("SELECT GET_LOCK(?,1) as my_lock",[objSignedMessage.aa_address]);
					if (!results[0].my_lock || results[0].my_lock === 0)
						return unlockAndHandle( "internal error");
				}

				const channels = await conn.query("SELECT * FROM channels WHERE aa_address=?", [objSignedMessage.aa_address]);
				if (channels.length === 0)
					return unlockAndHandle( "aa address not found");

				const channel = channels[0];
				if (channel.status == 'closing_initiated_by_me' || channel.status == 'closing_initiated_by_me_acknowledged')
					return unlockAndHandle( "closing initiated by peer");
				if (channel.status != 'open')
					return unlockAndHandle( "channel not open for peer");
				if (channel.period != objSignedMessage.period)
					return unlockAndHandle( "wrong period");
				if (objSignedMessage.amount_spent > (channel.amount_deposited_by_peer + channel.amount_spent_by_me))
					return unlockAndHandle( "AA not funded enough");

				const delta_amount_spent = Math.max(objSignedMessage.amount_spent - channel.amount_spent_by_peer, 0);
				const peer_credit = delta_amount_spent + channel.overpayment_from_peer;
				if (payment_amount > peer_credit)
					return unlockAndHandle( "Payment amount is over your available credit");

				await conn.query("UPDATE channels SET amount_spent_by_peer=amount_spent_by_peer+?,last_message_from_peer=?,overpayment_from_peer=?\n\
				WHERE aa_address=?", [delta_amount_spent, JSON.stringify(objSignedPackage), peer_credit - payment_amount, channel.aa_address]);
					return unlockAndHandle(null, payment_amount, channel.aa_address);
			});
		});
	});
}


exports.setAutoRefill = setAutoRefill;
exports.createNewChannel = createNewChannel;
exports.deposit = deposit;
exports.sendMessageAndPay = sendMessageAndPay;
exports.close = close;
exports.setCallBackForPaymentReceived = setCallBackForPaymentReceived;
exports.getBalancesAndStatus = getBalancesAndStatus;