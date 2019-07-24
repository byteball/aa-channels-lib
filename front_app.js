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

const REQUEST_TIMEOUT = 8*1000;

if (!conf.isHighAvaibilityNode) {
	require('./aa_watcher.js');
	var signedMessage = require('ocore/signed_message.js');
	var headlessWallet = require('headless-obyte');
} else {
	var signedMessage = require('./modules/signed_message.js'); // light version that doesn't require DAG DB
}

if (conf.enabledReceivers.includes('obyte-messenger') && conf.isHighAvaibilityNode)
	throw Error("Cannot use obyte-messenger layer as high avaibility node");


var paymentReceivedCallback;
var assocResponseByTag = {};
var my_address;

if (conf.isHighAvaibilityNode) { 
	var appDB = require('ocore/db.js');// to be replaced by external DB
} else{
	var appDB = require('ocore/db.js');
}

if (!conf.isHighAvaibilityNode) { // if another node is used as watcher, it is in charge to create table
	require('./sql/create_sqlite_tables.js');
}

if (conf.isHighAvaibilityNode){
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
			if (typeof request != 'object' || typeof request.body != 'object')
				return response.send({error: "bad request"});
			else 
				treatIncomingRequest(request.body, function(objResponse){
					return response.send(objResponse);
				});
		});
		app.listen(conf.httpDefaultPort);
		}

		setInterval(autoRefillChannels, 30000);
}


// treat requests received either by messenger or POST http
function treatIncomingRequest(objRequest, handle){
	console.log("treatIncomingRequest " + JSON.stringify(objRequest));

	if (objRequest.timestamp < (Date.now() - REQUEST_TIMEOUT/2))
		return handle({error:"Timestamp too old, check system time"});
	if (objRequest.command == 'create_channel'){
		if (typeof objRequest.params != "object")
			return handle({error:"No params"});
		if (!validationUtils.isStringOfLength(objRequest.params.salt,60))
			return handle({error:"Invalid salt"});
		if (objRequest.params.aa_version > conf.aa_version)
			return handle({error:"Unsupported aa version"});
		if (!validationUtils.isValidAddress(objRequest.params.address))
			return handle({error:"Invalid payment address"});
		if (objRequest.params.url && !isUrl(objRequest.params.url))
			return handle({error:"Invalid url"});
		return createNewChannelOnPeerRequest(objRequest, handle);
	}

	if (objRequest.command == 'pay'){
		if (typeof objRequest.params != "object")
			return handle({error:"No params"});
		return treatPaymentFromPeer(objRequest, handle);
	}

}


function treatPaymentFromPeer(objRequest, handle){
	const objSignedPackage = objRequest.params.signed_package;

	signedMessage.validateSignedMessage(objSignedPackage, async (error)=>{
		if (error){
			console.error("error when validating message: "+ error);
			return handle({error:error});
		}
		const objSignedMessage = objSignedPackage.signed_message;

		if (typeof objSignedMessage != 'object')
			return handle({error:"signed message should be an object"});

		if (!validationUtils.isValidAddress(objSignedMessage.channel))
			return handle({error:"aa address is not valid"});

		mutex.lock
		const channels = await appDB.query("SELECT * FROM channels WHERE aa_address=?", [objSignedMessage.channel]);
		if (channels.length === 0)
			return handle({error:"aa address not found"});
	
		const channel = channels[0];

		if (channel.status != 'open')
			return handle({error:"channel not open for peer"});

		if (channel.period != objSignedMessage.period)
			return handle({error:"wrong period"});

		if (!validationUtils.isPositiveInteger(objSignedMessage.amount_spent))
			return handle({error:"amount_spent should be a positive integer"});

		if (!validationUtils.isPositiveInteger(objSignedMessage.payment_amount))
			return handle({error:"payment_amount should be a positive integer"});

		const payment_amount = objSignedMessage.payment_amount;

		if (objSignedMessage.amount_spent > (channel.amount_deposited_by_peer + channel.amount_spent_by_me))
			return handle({error:"AA not funded enough"});

		const delta_amount_spent = (objSignedMessage.amount_spent - channel.amount_spent_by_peer) > 0 ? (objSignedMessage.amount_spent - channel.amount_spent_by_peer) : 0;
		const peer_credit =  delta_amount_spent + channel.credit_attributed_to_peer;
		
		if (payment_amount > peer_credit)
			return handle({error:"Payment amount is over your available credit"});

		await appDB.query("UPDATE channels SET amount_spent_by_peer=amount_spent_by_peer+?,last_message_from_peer=?,credit_attributed_to_peer=?\n\
		WHERE aa_address=?", [delta_amount_spent, JSON.stringify(objSignedPackage), objSignedMessage.channel], peer_credit -payment_amount);
		if (paymentReceivedCallback){
				paymentReceivedCallback(payment_amount, objRequest.params.message,channel.aa_address, function(error, response){
					if (error)
						return handle({error: error});
					else
						return handle({response: response});
				});
			} else {
				return handle({response:"received payment for " + amount });
			}
	});
}



function createNewChannelOnPeerRequest(objRequest, handle){
	console.error(JSON.stringify(objRequest));
	const objAAParameters= aaDefinitions.getAddressAndParametersForAA(my_address, objRequest.params.address, objRequest.params.salt);
	appDB.query("INSERT " + appDB.getIgnore() + " INTO channels (aa_address,version,salt,peer_address,peer_device_address,peer_url) VALUES (?,?,?,?,?,?)",
	[objAAParameters.aa_address, objAAParameters.version, objRequest.params.salt, objRequest.params.address, objRequest.from_address, objRequest.url], function(result){

		if (result.affectedRows !== 1)
			return handle({error:"this salt already exists"});
		else{
			eventBus.emit("channel_created_by_peer", objRequest.params.address, objAAParameters.aa_address);
			return handle({response: objAAParameters});
		}

	});
}


function setCallBackForPaymentReceived(_cb){
	paymentReceivedCallback = _cb;
}

async function close(aa_address, handle){
	if (!conf.isHighAvaibilityNode){
		const results = await appDB.query("SELECT amount_spent_by_peer,amount_spent_by_me,last_message_from_peer, period FROM channels WHERE aa_address=?",[aa_address]);
		if (results.length === 0)
			return handle("unknown AA address");
		const composer = require('ocore/composer.js');
		const network = require('ocore/network.js');
		const callbacks = composer.getSavingCallbacks({
			ifNotEnoughFunds: ()=>{
				handle("not enough fund to close channel");
			},
			ifError: (error)=>{
				handle("error when closing channel " + error);
			},
			preCommitCb: function(conn, objJoint, cb){
				conn.query("UPDATE channels SET status='closing_initiated_by_me' WHERE aa_address=?",[aa_address]);
				cb();
			},
			ifOk: function(objJoint){
				network.broadcastJoint(objJoint);
				handle(null);
			}
		})

		const payload = { close: 1, period: results[0].period};
		if (results[0].amount_spent_by_me > 0)
			payload.transferredFromMe = results[0].amount_spent_by_me;
		if (results[0].amount_spent_by_peer > 0)
			payload.sentByPeer = JSON.parse(results[0].last_message_from_peer);

		const objMessage = {
			app: 'data',
			payload_location: "inline",
			payload_hash: objectHash.getBase64Hash(payload),
			payload: payload
		};

		composer.composeJoint({
			paying_addresses: [my_address], 
			outputs: [{address: my_address, amount: 0}, {address: aa_address, amount: 10000}], 
			signer: headlessWallet.signer,
			messages: [objMessage],
			callbacks: callbacks
		});
	} else {
		//order aa watcher to close channel
		const result = await appDB.query("UPDATE channels SET closing_authored=1 FROM channels WHERE aa_address=?",[aa_address]);
		if (result.affectedRows !== 1)
			return handle("aa address not known");
		else
			return handle(null);
	}
}


function deposit(aa_address, amount, handle){
	if (conf.isHighAvaibilityNode)
		return handle("high availability node can only receive funds");
	if (!validationUtils.isPositiveInteger(amount))
		return handle("amount must be positive integer");
	if (amount < 1e5)
		return handle("amount must be >= 1e5");
	mutex.lock([aa_address], async function(unlock){
		const channels = await appDB.query("SELECT status FROM channels WHERE aa_address=?",[aa_address]);
		if (channels.length != 1){
			unlock();
			return handle ("unknown channel");
		}

		if (channels[0].status != "open" && channels[0].status != "closed" && channels[0].status != "created"){
			unlock();
			return handle("channel status: "+  channels[0].status+ ", no deposit possible");
		}

		const composer = require('ocore/composer.js');
		const network = require('ocore/network.js');
		const callbacks = composer.getSavingCallbacks({
			ifNotEnoughFunds: ()=>{
				unlock();
				handle("not enough fund to fund chanel");
			},
			ifError: (error)=>{
				unlock();
				handle("not enough fund " + error);
			},
			preCommitCb: function(conn, objJoint, cb){
				conn.query("INSERT INTO pending_deposits (unit, amount, aa_address) VALUES (?, ?, ?)",[objJoint.unit.unit, amount, aa_address]);
				cb();
			},
			ifOk: function(objJoint){
				network.broadcastJoint(objJoint);
				unlock();
				handle(null, objJoint.unit.unit);
			}
		})
		composer.composeJoint({
			paying_addresses: [my_address], 
			outputs: [{address: my_address, amount: 0}, {address: aa_address, amount: amount}], 
			signer: headlessWallet.signer, 
			callbacks: callbacks
		});
	});
}


function createNewChannel(peer, initial_amount, handle){
	if (conf.isHighAvaibilityNode)
		return handle("high availability node cannot create channel");
	if (!my_address)
		return handle("not initialized");
	if (!validationUtils.isPositiveInteger(initial_amount))
		return handle("amount must be positive integer");
	if (initial_amount < 1e5)
		return handle("initial_amount must be >= 1e5");
	const salt =  crypto.randomBytes(30).toString('hex');
	let matches = peer.match(/^([\w\/+]+)@([\w.:\/-]+)#([\w\/+-]+)$/);

	const objToBeSent = {
		command:"create_channel", 
		params:{
			salt: salt, 
			address: my_address
		}
	}
	const responseCb = function(responseFromPeer){
		treatResponseToChannelCreation(responseFromPeer, function(error, response){
			if (error)
				return handle(error);
			return handle(null,response);
		});
	}

	if (matches){ //it's a pairing address
		if (conf.isHighAvaibilityNode)
			return handle("pairing address cannot be used in high availability mode");
		var correspondent_address;
		var peer_url;
		correspondents.findCorrespondentByPairingCode(peer, (correspondent) => {
			if (!correspondent) {
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
	} else if(isUrl(peer)){
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
		if (my_address != response.address_b)
			return handle('address b is not mine');

		const objCalculatedAAParameters = aaDefinitions.getAddressAndParametersForAA(response.address_a, my_address, salt);
		if (objCalculatedAAParameters.aa_address !== response.aa_address)
			return handle('peer calculated different aa address');

		const result = await appDB.query("INSERT " + appDB.getIgnore() + " INTO channels (aa_address,version,salt,peer_address,peer_device_address,peer_url) VALUES (?,?,?,?,?,?)",
				[response.aa_address, response.version, salt, response.address_a, correspondent_address || null, peer_url || null]);
		if (result.affectedRows !== 1)
			return handle("this salt already exists");
		else{
			sendDefinitionAndDepositToChannel(response.aa_address,objCalculatedAAParameters.arrDefinition, initial_amount).then((unit)=>{
				return handle(null, response.aa_address, unit);
			},(error)=>{
				return handle(error);
			});
		}
	}
}

function sendMessageAndPay(aa_address, message, payment_amount,handle){
	if (conf.isHighAvaibilityNode)
		return handle("high availability node can only receive payment");
	if (!my_address)
		return handle("not initialized");
	mutex.lock([aa_address], async function(unlock){

		function unlockAndHandle(error, response){
			unlock();
			handle(error, response);
		}
		const channels = await appDB.query("SELECT status,period,peer_device_address,peer_url,amount_deposited_by_me,amount_spent_by_peer,amount_spent_by_me FROM channels WHERE aa_address=?",[aa_address]);

		if (channels.length === 0)
			return unlockAndHandle("AA address not found");

		const channel = channels[0];
	
		if (channel.status != "open")
			return unlockAndHandle("Channel is not open");

		const myFreeAmountOnAA = channel.amount_deposited_by_me - channel.amount_spent_by_me + channel.amount_spent_by_peer;

		if (payment_amount > myFreeAmountOnAA)
			return unlockAndHandle("AA not funded enough");

		const objSignedPackage = await signMessage({payment_amount: payment_amount, amount_spent: (amount + channel.amount_spent_by_me), period: channel.period, channel: aa_address}, my_address);

		const objToBeSent = {
			command:"pay",
			timestamp: Date.now(),
			params:{
				signed_package : objSignedPackage,
				message: message
			}
		}
		const responseCb = async function(responseFromPeer){
			if (responseFromPeer.error){
				await appDB.query("UPDATE channels SET amount_spent_by_me=amount_spent_by_me-? WHERE aa_address=?", [amount, aa_address]); // if peer returned an error, we cancel the increment
				return unlockAndHandle(responseFromPeer.error);
			}
			if (!responseFromPeer.response)
				return unlockAndHandle('bad response from peer');
			return unlockAndHandle(null, responseFromPeer.response);
		}

		const timeOutCb =  function(){
			return unlockAndHandle('no response from peer');
		};

		await appDB.query("UPDATE channels SET amount_spent_by_me=amount_spent_by_me+? WHERE aa_address=?", [amount, aa_address]);

		if (channel.peer_device_address){
			if (conf.isHighAvaibilityNode)
				return unlockAndHandle("device address cannot be used in high availability mode");
			sendRequestToPeer("obyte-messenger", channel.peer_device_address, objToBeSent, responseCb, timeOutCb);
		} else if (channel.peer_url){
			sendRequestToPeer("http", channel.peer_url, objToBeSent, responseCb, timeOutCb);
		} else {
			return unlockAndHandle("no layer com available for this peer");
		}
	});
}

function signMessage(message, address) {
	return new Promise((resolve, reject) => {
			signedMessage.signMessage(message, address, headlessWallet.signer, false, function (err, objSignedPackage) {
					if (err)
							return reject(err);
					resolve(objSignedPackage);
			});
	});
}


function sendRequestToPeer(comLayer, peer_address, objToBeSent, responseCb, timeOutCb) {
	const tag = crypto.randomBytes(30).toString('hex');
	assocResponseByTag[tag] = responseCb;
	objToBeSent.tag = tag;
	if (comLayer == "obyte-messenger"){
		if (conf.isHighAvaibilityNode)
			throw Error("obyte messenger no available in high avaibility mode");
		const device = require('ocore/device.js');
		device.sendMessageToDevice(peer_address, 'object', objToBeSent);
	} else if (comLayer == "http"){
		request.post(peer_address + "post", {
			json: objToBeSent
		}, (error, res, body) => {
			if (error || res.statusCode != 200) {
				return console.error("error in response from peer: " + peer_address + " " + JSON.stringify(res));
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


function sendDefinitionAndDepositToChannel(aa_address, arrDefinition, filling_amount){
	return new Promise(async (resolve, reject) => {

		const payload = { address: aa_address, definition: arrDefinition };

		const composer = require('ocore/composer.js');
		const network = require('ocore/network.js');
		const callbacks = composer.getSavingCallbacks({
			ifNotEnoughFunds: ()=>{
				reject("not enough fund to fund chanel");
			},
			ifError: (error)=>{
				reject("error when creating channel " + error);
			},
			preCommitCb: function(conn, objJoint, cb){
				conn.query("INSERT INTO pending_deposits (unit, amount, aa_address) VALUES (?, ?, ?)",[objJoint.unit.unit, filling_amount, aa_address]);
				cb();
			},
			ifOk: function(objJoint){
				network.broadcastJoint(objJoint);
				resolve(objJoint.unit.unit);
			}
		})

		composeContentJointAndFill(filling_amount, 'definition', payload, callbacks);
	});
}


function composeContentJointAndFill( amount, app, payload, callbacks){
	var composer = require('ocore/composer.js');
	var objMessage = {
		app: app,
		payload_location: "inline",
		payload_hash: objectHash.getBase64Hash(payload),
		payload: payload
	};

	composer.composeJoint({
		paying_addresses: [my_address], 
		outputs: [{address: my_address, amount: 0}, {address: payload.address, amount: amount}], 
		messages: [objMessage], 
		signer: headlessWallet.signer, 
		callbacks: callbacks
	});
}

function autoRefillChannels(){
	mutex.lock(["autoRefillChannels"], async function(unlock){
		const rows = await appDB.query("SELECT channels.aa_address, auto_refill_threshold, auto_refill_amount, (amount_deposited_by_me - amount_spent_by_me + amount_spent_by_peer) AS free_amount,\n\
		IFNULL((SELECT SUM(amount) FROM pending_deposits WHERE pending_deposits.aa_address=channels.aa_address AND is_confirmed_by_aa=0),0) AS pending_amount\n\
		FROM channels WHERE (free_amount + pending_amount) < auto_refill_threshold");
		async.eachSeries(rows,function(row, cb){
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
	const result = 	await appDB.query("UPDATE channels SET auto_refill_threshold=?,auto_refill_amount=? WHERE aa_address=?",[refill_threshold,refill_amount,aa_address]);
	if (result.affectedRows !== 1)
		return handle("aa_address not known");
	else
		return handle(null);
}

async function getBalancesAndStatus(aa_address, handle){
	const rows = 	await appDB.query("SELECT status,amount_deposited_by_me,amount_spent_by_me, amount_spent_by_peer, (amount_deposited_by_me - amount_spent_by_me + amount_spent_by_peer) AS free_amount,\n\
	IFNULL((SELECT SUM(amount) FROM pending_deposits WHERE pending_deposits.aa_address=channels.aa_address AND is_confirmed_by_aa=0),0) AS pending_deposits\n\
	FROM channels WHERE channels.aa_address=?",[aa_address]);
	if (rows.length === 0)
		return handle("aa_address not known");
	else
		return handle(null,rows[0]);

}


exports.setAutoRefill = setAutoRefill;
exports.createNewChannel = createNewChannel;
exports.deposit = deposit;
exports.sendMessageAndPay = sendMessageAndPay;
exports.close = close;
exports.setCallBackForPaymentReceived = setCallBackForPaymentReceived;
exports.getBalancesAndStatus= getBalancesAndStatus;