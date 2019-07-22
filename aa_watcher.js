/*jslint node: true */
'use strict';
const dagDB = require('ocore/db.js');
const walletGeneral = require('ocore/wallet_general.js');
const conf = require('ocore/conf.js');
const eventBus = require('ocore/event_bus.js');
const mutex = require('ocore/mutex.js');
const headlessWallet = require('headless-obyte');
const objectHash = require('ocore/object_hash.js');


if (!conf.isHighAvaibilityNode) {
	require('./sql/create_sqlite_tables.js');
	var appDB = require('ocore/db.js');
} else {
	var appDB = require('ocore/db.js');// to be replaced by external DB
}

var my_address;


eventBus.once('headless_wallet_ready', function(){

	headlessWallet.readFirstAddress(async function(_my_address){
		my_address = _my_address;
		await appDB.query("INSERT "+ dagDB.getIgnore() + " INTO channels_config (my_address) VALUES (?)", [_my_address]);
		treatNewStableUnits(); // we look for units that weren't treated in case node was interrupted at bad time
		lookForAndProcessTasks();
		setInterval(lookForAndProcessTasks, 5000);
	});
});

eventBus.on('my_transactions_became_stable', function(arrUnits){
	treatNewStableUnits(arrUnits);
});


function lookForAndProcessTasks(){
	updateAddressesToWatch();
	confirmClosingAfterTimeout();
}

async function updateAddressesToWatch(){
	var watched_addresses = await dagDB.query("SELECT address FROM my_watched_addresses");
	var rows = await appDB.query("SELECT aa_address FROM channels WHERE aa_address NOT IN ('"+watched_addresses.map(function(row){ return row.address}).join("','")+"')");
	rows.forEach(function(row){
		walletGeneral.addWatchedAddress(row.aa_address, ()=>{
		});
	});
}


async function getSqlFilterForNewUnitsFromChannels(){
	return new Promise(async (resolve, reject) => {
		const rows = await appDB.query("SELECT peer_address,last_updated_mci,aa_address FROM channels");
		var string = rows.length > 0 ? " (" : " 0 AND ";
		var i = 0;
		rows.forEach(function(row){
			i++;
		//	string += "((outputs.address='"+row.aa_address + "' OR author_address='" + row.aa_address + "') " + " AND main_chain_index>"  + row.last_updated_mci +") ";
		string += "(author_address='" + row.aa_address  + "' AND main_chain_index>"  + row.last_updated_mci +") ";
		string += rows.length > i ? " OR " : "";
		});
		string += rows.length > 0 ? ") AND " : "";
		resolve(string);
	});
}



function treatNewStableUnits(arrUnits){	
	mutex.lock(['treatNewStableUnits'], async (unlock)=>{
	var unitFilter = arrUnits ? " units.unit IN("+arrUnits.map(dagDB.escape).join(',')+") AND " : ""; 
	const new_units = await dagDB.query("SELECT timestamp,units.unit,outputs.address AS output_address,outputs.amount,main_chain_index,unit_authors.address AS author_address FROM units \n\
		CROSS JOIN outputs USING(unit)\n\
		CROSS JOIN unit_authors USING(unit)\n\
		WHERE "+unitFilter+ await getSqlFilterForNewUnitsFromChannels() + " outputs.asset IS NULL AND is_stable=1 AND sequence='good' GROUP BY units.unit ORDER BY main_chain_index, units.unit, output_address ASC");
		if (new_units.length === 0){
			unlock();
			return console.log("nothing concerns payment channel in these units");
		}

		for (var i=0; i<new_units.length; i++) {
			var new_unit= new_units[i];
			var channels = await appDB.query("SELECT * FROM channels WHERE aa_address=? OR aa_address=?",[new_unit.output_address, new_unit.author_address ]);
			if (!channels[0])
				throw Error("channel not found");

			var payloads =	await dagDB.query("SELECT payload FROM messages WHERE unit=? AND app='data' ORDER BY message_index ASC LIMIT 1",[new_unit.unit]);

			async function setLastUpdatedMciAndBalanceAndOthersFields(event_id, fields){
				var strSetFields  = "";
				if (fields)
					for (var key in fields){
						strSetFields+= ","+key+"='" + fields[key] + "'";
					}
				await appDB.query("UPDATE channels SET last_updated_mci=?,last_event_id=?"+strSetFields+" WHERE aa_address=? AND last_event_id<?",[new_unit.main_chain_index,event_id, new_unit.author_address,event_id]);
			}

			var channel = channels[0];
			var payload = payloads[0] ? JSON.parse(payloads[0].payload) : null;
			console.log("payload: " + payload);

			//channel is open and received funding
			if (payload && payload.open){
				await appDB.query("UPDATE pending_deposits SET is_confirmed_by_aa=1 WHERE unit=?",[payload.trigger_unit]);
				await setLastUpdatedMciAndBalanceAndOthersFields(payload.event_id, {status: "open", period: payload.period, amount_deposited_by_peer:payload[channel.peer_address], amount_deposited_by_me:payload[my_address]})
			}

			//closing requested by one party
			if (payload && payload.closing){
				if (payload.initiated_by === my_address)
					var status = "closing_initiated_by_me";
				else {
					var status = "closing_initiated_by_peer";
					if (payload[channel.peer_address] >= channel.amount_spent_by_peer){
						confirmClosing(new_unit.output_address, payload.period); //peer is honest, we send confirmation for closing
					} else {
						confirmClosing(new_unit.output_address, payload.period, channel.last_message_from_peer); //peer isn't honest, we confirm closing with a fraud proof
					}
				}
				await setLastUpdatedMciAndBalanceAndOthersFields(payload.event_id, {status: status, period: payload.period, close_timestamp: new_unit.timestamp});
			}
			//AA confirms that channel is closed
			if (payload && payload.closed){
				await setLastUpdatedMciAndBalanceAndOthersFields(payload.event_id, {status: "closed", period: payload.period,amount_spent_by_peer:0, amount_spent_by_me:0, amount_deposited_by_peer:0, amount_deposited_by_me: 0, last_message_from_peer:''});
			}

			if (payload && payload.refused){
				await appDB.query("UPDATE pending_deposits SET is_confirmed_by_aa=1 WHERE unit=?",[payload.trigger_unit]);
				await setLastUpdatedMciAndBalanceAndOthersFields(payload.event_id, {});
			}
		}
		unlock();
	});
}



function confirmClosing(aa_address, period, fraud_proof){
	const composer = require('ocore/composer.js');
	const network = require('ocore/network.js');
	const callbacks = composer.getSavingCallbacks({
		ifNotEnoughFunds: ()=>{
			console.log("not enough fund to close channel");
		},
		ifError: (error)=>{
			console.log("error when closing channel " + error);
		},
		ifOk: function(objJoint){
			network.broadcastJoint(objJoint);
		},
		preCommitCb: (conn, objJoint, handle)=>{
			conn.query("UPDATE channels SET status='confirmed_by_me' WHERE aa_address=?",[aa_address]);
			handle();
		},
	})

	if (fraud_proof){
		var payload = { fraud_proof: 1, period: period, sentByPeer: JSON.parse(fraud_proof)};
	} else {
		var payload = { confirm: 1, period: period};
	}

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
}

async function confirmClosingAfterTimeout(){
	const current_ts = Math.round(Date.now() / 1000);
	const rows =	await appDB.query("SELECT aa_address,period FROM channels WHERE status='closing_initiated_by_me' AND close_timestamp <?",[current_ts - 300]);
	rows.forEach(function(row){
		confirmClosing(row.aa_address, row.period);
	});
}



/*
			//first condition
			if (new_unit.amount && new_unit.amount >= 1e5 && (new_unit.output_address == my_address || new_unit.output_address == channel.peer_address)){
				console.log("first condition met");
				if (channel.status=='close_initiated_by_me' || channel.status=='close_initiated_by_peer')
					await setLastUpdatedMciAndBalanceAndOthersFields(false, false);
				else if (new_unit.output_address == my_address)
					await setLastUpdatedMciAndBalanceAndOthersFields(true,{status:"open", amount_deposited_by_me: channel.amount_deposited_by_me + new_unit.amount});
				else if (new_unit.output_address == channel.peer_address)
					await setLastUpdatedMciAndBalanceAndOthersFields(true,{status:"open", amount_deposited_by_peer: channel.amount_deposited_by_peer + new_unit.amount});

			} else if ( (new_unit.output_address == my_address || new_unit.output_address == channel.peer_address)	
			 && payload && payload.close && channel.status !='close_initiated_by_peer' && channel.status !='close_initiated_by_me' ){//second condition
				var transferredFromMe = payload.transferredFromMe || 0;
				if (transferredFromMe < 0)
					await setLastUpdatedMciAndBalanceAndOthersFields(false, false);
				else if (payload && typeof payload.sentByPeer == 'object'){
						if (payload.sentByPeer.signed_message != 'object')
							await setLastUpdatedMciAndBalanceAndOthersFields(false, false);
						else if (payload.sentByPeer.signed_message && payload.sentByPeer.signed_message.channel != channel.address)
							await setLastUpdatedMciAndBalanceAndOthersFields(false, false);
						else if (payload.sentByPeer.signed_message && payload.sentByPeer.signed_message.period !== channel.period)
							await setLastUpdatedMciAndBalanceAndOthersFields(false, false);
						else if (new_unit.output_address == my_address && !await promiseValidateSignedMessage(payload.sentByPeer.signed_message, my_address)||
						new_unit.output_address == channel.peer_address && !await promiseValidateSignedMessage(payload.sentByPeer.signed_message, channel.peer_address))
							await setLastUpdatedMciAndBalanceAndOthersFields(false, false);
						else if (!payload.sentByPeer.signed_message.amount_spent || payload.sentByPeer.signed_message.amount_spent < 0)
							await setLastUpdatedMciAndBalanceAndOthersFields(false, false);
						else
							var transferredFromPeer = payload.sentByPeer.signed_message.amount_spent;
						} else{
							var transferredFromPeer = 0;
							var my_final_balance = channel.amount_deposited_by_me - transferredFromMe + transferredFromPeer;
							var peer_final_balance =  channel.amount_deposited_by_peer- transferredFromPeer + transferredFromMe;
							if (my_final_balance < 0 || peer_final_balance < 0)
								await setLastUpdatedMciAndBalanceAndOthersFields(false, false);
							else 
								await setLastUpdatedMciAndBalanceAndOthersFields(true, );


						}
					console.log("payload " + JSON.stringify(payloads));

					if (!payloads[0] || !payloads[0].payload) {
						setLastUpdatedMciAndBalanceAndOthersFields();
						console.log("no message in " + new_unit.unit);
					} else {
					try{
						var payload = JSON.parse(payloads[0].payload);
					} catch (e) {
						setLastUpdatedMciAndBalanceAndOthersFields();
						console.log("invalid payload" + e);
					}
					if (payload && payload.close && payload.transferredFromMe >=0 && new_unit.author_address == channel.client_address){
						console.log("onPeerCloseChannel");
						await onPeerCloseChannel(channel.aa_address, payload.transferredFromMe, new_unit.main_chain_index, channel);
					} else if (payload.closed && new_unit.author_address == channel.aa_address ){
						console.log("onClosedChannel");
						if (payload.period != channel.period)
							throw Error("period mismatches")
					 await onClosedChannel(channel.aa_address, new_unit.main_chain_index);
					}
				}
			}

			 }*/