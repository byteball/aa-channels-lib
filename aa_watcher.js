/*jslint node: true */
'use strict';
const dagDB = require('ocore/db.js');
const walletGeneral = require('ocore/wallet_general.js');
const conf = require('ocore/conf.js');
const eventBus = require('ocore/event_bus.js');
const mutex = require('ocore/mutex.js');
const headlessWallet = require('headless-obyte');
const objectHash = require('ocore/object_hash.js');
const async = require('async');
const myWitnesses = require('ocore/my_witnesses.js');
const light = require('ocore/light.js');
const lightWallet = require('ocore/light_wallet.js');
const constants = require('ocore/constants.js');

if (!conf.isHighAvailabilityNode){
	require('./sql/create_sqlite_tables.js');
	var appDB = require('ocore/db.js');
} else {
	require('./sql/create_mysql_tables.js');
	var appDB = require('./modules/external_db.js');
}

var my_address;
const assocJointsFromPeersCache = {};

eventBus.once('headless_wallet_ready', function(){
	headlessWallet.readFirstAddress(async function(_my_address){
		my_address = _my_address;
		await appDB.query("INSERT " + appDB.getIgnore() + " INTO channels_config (my_address) VALUES (?)", [_my_address]);
		await treatUnitsFromAA(); // we look for units that weren't treated in case node was interrupted at bad time
		setInterval(lookForAndProcessTasks, 2000);
	});
});

if (conf.bLight){
	eventBus.on('my_transactions_became_stable', function(arrUnits){
		treatUnitsFromAA(arrUnits);
	});
} else {
	eventBus.on('new_aa_unit', async function(objUnit){
		const channels = await appDB.query("SELECT 1 FROM channels WHERE aa_address=?", [objUnit.authors[0].address]);
		if (channels[0])
			treatUnitsFromAA([objUnit.unit]);
	});

	eventBus.on('my_transactions_became_stable', function(arrUnits){
		updateLastMci(arrUnits); // once units from AA become stable, MCI is known and we can update last_updated_mci
	});
}

eventBus.on('new_my_transactions', function(arrUnits){
	if(conf.bLight && !lightWallet.isFirstHistoryReceived()) // we ignore all new transactions that could come from a node resyncing from scratch - to do: find solution for full node
		return console.log("first history not processed");
	treatUnconfirmedUnitsToAA(arrUnits);
});

eventBus.on('sequence_became_bad', function(arrUnits){
	appDB.query("UPDATE unconfirmed_units_from_peer SET is_bad_sequence=1 WHERE unit IN(?)", [arrUnits]);
});


eventBus.on('aa_response', function(objAAResponse){
	if (objAAResponse.bounced) {
		console.log("bounced unit: " + objAAResponse.trigger_unit);
		appDB.query("DELETE FROM unconfirmed_units_from_peer WHERE unit=?", [objAAResponse.trigger_unit]);
		appDB.query("UPDATE channels SET unconfirmed_status=NULL WHERE last_unconfirmed_status_unit=?", [objAAResponse.trigger_unit]);
	}
});


function lookForAndProcessTasks(){ // main loop for repetitive tasks
	if(conf.bLight && !lightWallet.isFirstHistoryReceived())
		return console.log("first history not processed");
	updateAddressesToWatch();
	confirmClosingIfTimeoutReached();
	if (conf.isHighAvailabilityNode)
		treatClosingRequests();
}

// we compare the list of currently watched addresses with the list of channels addresses, and watch those not watched yet
async function updateAddressesToWatch(){

	var watched_addresses = (await dagDB.query("SELECT address FROM my_watched_addresses")).map(function(row){ return row.address }).join("','");
	var rows_aa_addresses = await appDB.query("SELECT aa_address FROM channels WHERE aa_address NOT IN ('" + watched_addresses + "')");
	if (rows_aa_addresses.length === 0)
		return console.log("nothing new to watch");

	var aa_addresses = rows_aa_addresses.map(row => row.aa_address);

	if (conf.bLight){

		var aa_addresses_list = aa_addresses.map(dagDB.escape).join(', ');
		var knownsUnitsRows  = await dagDB.query("SELECT unit FROM unit_authors CROSS JOIN units USING(unit) WHERE is_stable=1 AND address IN("+aa_addresses_list+") \n\
		UNION \n\
		SELECT unit FROM outputs CROSS JOIN units USING(unit) WHERE is_stable=1 AND address IN("+aa_addresses_list+")");
	
		myWitnesses.readMyWitnesses(async function(witnesses){

			const objRequest = {addresses: aa_addresses, witnesses: witnesses};
			if (knownsUnitsRows.length)
				objRequest.known_stable_units = knownsUnitsRows.map(function(row){ return row.unit; });
			const network = require('ocore/network.js');
			network.requestFromLightVendor('light/get_history', objRequest,  function(ws, request, response){ // we prepare our own history request to put new joints in cache
				if (response.error || (!response.joints && !response.unstable_mc_joints))
					return console.log('no joint received');
				if (response.joints)
					response.joints.forEach(function(objUnit){
						assocJointsFromPeersCache[objUnit.unit.unit] = objUnit.unit;
					})
				light.processHistory(response, objRequest.witnesses, {
					ifError: function(err){
						console.log("error when processing history for " + row.aa_address +" "+ err);
					},
					ifOk: function(){
						console.log("history processed for " + aa_addresses_list);
						treatUnitsAndAddWatchedAddresses();
					}
				});
			});
		});
	} else {
		treatUnitsAndAddWatchedAddresses();
	}

	async function treatUnitsAndAddWatchedAddresses(){
		await treatUnitsFromAA(); // we treat units from AA first to get more recent confirmed states
		await treatUnconfirmedUnitsToAA(); 
		aa_addresses.forEach(function(aa_address){
			walletGeneral.addWatchedAddress(aa_address, ()=>{});
		});
	}
}


async function getSqlFilterForNewUnitsFromChannels(){
	const rowsAddresses = await appDB.query("SELECT last_updated_mci,aa_address FROM channels");
	if (rowsAddresses.length === 0)
		return " 0 ";

	const rowsMaxLastUpdatedMci = await appDB.query("SELECT CASE WHEN MAX(last_updated_mci) IS NOT NULL THEN (MAX(last_updated_mci)) ELSE 0 END min_mci FROM channels;");
	return " author_address IN ('" + rowsAddresses.map(function(row){return row.aa_address}).join("','") + "') " 
	+ "AND (main_chain_index>=" + rowsMaxLastUpdatedMci[0].min_mci + " OR main_chain_index IS NULL)";
}

async function getSqlFilterForNewUnitsFromPeers(aa_address){
	const rowsAddresses = await appDB.query("SELECT peer_address,aa_address FROM channels " + (aa_address ? " WHERE aa_address='"+aa_address+"'" : ""));
	if (rowsAddresses.length === 0)
		return " 0 ";

	return "outputs.address IN ('" +  rowsAddresses.map(function(row){return row.aa_address}).join("','") +"')" +
	" AND author_address IN ('" +  rowsAddresses.map(function(row){return row.peer_address}).join("','") +"')" +
	" AND is_stable=0";
}


function treatUnconfirmedUnitsToAA(arrUnits, aa_address){
	return new Promise(async (resolve) => {
		mutex.lock(['treatUnconfirmedUnitsToAA'], async (unlock) => {
			const unitFilter = arrUnits ? " units.unit IN(" + arrUnits.map(dagDB.escape).join(',') + ") AND " : "";
			// we select units having output address and author matching known channels
			const new_units = await dagDB.query("SELECT DISTINCT timestamp,units.unit,main_chain_index,unit_authors.address AS author_address FROM units \n\
			CROSS JOIN unit_authors USING(unit)\n\
			CROSS JOIN outputs USING(unit)\n\
			WHERE "+ unitFilter + await getSqlFilterForNewUnitsFromPeers(aa_address));
			if (new_units.length === 0){
				unlock();
				console.log("nothing destinated to AA in these units");
				return resolve();
			}
			console.log(new_units.length + " destinated to AA to be treated");
			for (var i = 0; i < new_units.length; i++){
				var new_unit = new_units[i];
				var channels = await appDB.query("SELECT aa_address FROM channels WHERE peer_address=?", [new_unit.author_address]);
				if (!channels[0])
					throw Error("channel not found");
				await	treatNewOutputsToChannels(channels, new_unit);
				delete assocJointsFromPeersCache[new_unit];
			}
			unlock();
			resolve();
		});
	});
}

function treatNewOutputsToChannels(channels, new_unit){
	return new Promise(async (resolve) => {
		async.eachSeries(channels, function(channel, eachCb){
			mutex.lock([channel.aa_address], async function(unlock_aa){
				var connAppDb = await appDB.takeConnectionFromPool();
				if (conf.isHighAvailabilityNode) {
					var connDagDb = dagDB;
					var results = await	connAppDb.query("SELECT GET_LOCK(?,1) as my_lock",[channel.aa_address]);
					if (!results[0].my_lock || results[0].my_lock === 0){
						 connAppDb.release();
						 unlock_aa();
						 eachCb();
						return console.log("couldn't get lock from MySQL " + channel.aa_address);
					}
				} else {
					var connDagDb = connAppDb;
				}
				var lockedChannelRows = await connAppDb.query("SELECT * FROM channels WHERE aa_address=?", [channel.aa_address]);
				var lockedChannel = lockedChannelRows[0];
				var byteAmountRows = await connDagDb.query("SELECT SUM(amount) AS amount FROM outputs WHERE unit=? AND address=? AND asset IS NULL", [new_unit.unit, channel.aa_address]);
				var byteAmount = byteAmountRows[0] ? byteAmountRows[0].amount : 0;
				if (lockedChannel.peer_address == new_unit.author_address && byteAmount >= constants.MIN_BYTES_BOUNCE_FEE){ // check the minimum to not be bounced is reached 
					var sqlAsset = lockedChannel.asset == 'base' ? "" : " AND asset='"+lockedChannel.asset +"' ";
					var amountRows = await connDagDb.query("SELECT SUM(amount) AS amount  FROM outputs WHERE unit=? AND address=?" + sqlAsset, [new_unit.unit, channel.aa_address]);
					var amount = amountRows[0].amount;

					var bHasDefinition, bHasData, bHasClose, bHasConfirm = false;

					var joint = await getJointFromCacheStorageOrHub(connDagDb, new_unit.unit);
					if (joint){
						joint.messages.forEach(function(message){
							if (message.app == "definition" && message.payload.address == channel.aa_address){
								bHasDefinition = true;
							}
							if (message.app == "data"){
								bHasData = true;
								if (message.payload.close)
									bHasClose = true;
								if (message.payload.confirm || message.payload.fraud_proof)
									bHasConfirm = true;
							}
						});
					}
						
					// this timestamp will be used to check how long the unit has been known from network, 
					// so we use current timestamp, not the unit one that could have been backtimed
					var timestamp = Math.round(Date.now() / 1000); 

					if (bHasClose) {
						await connAppDb.query("INSERT " + connAppDb.getIgnore() + " INTO unconfirmed_units_from_peer (aa_address,close_channel,unit,timestamp) VALUES (?,1,?,?)",
						[channel.aa_address,new_unit.unit, timestamp]);
						await connAppDb.query("UPDATE channels SET unconfirmed_status='closing_initiated_by_peer',last_unconfirmed_status_unit=? WHERE aa_address=?",[new_unit.unit, channel.aa_address]);

					} else if (bHasConfirm){
						await connAppDb.query("UPDATE channels SET unconfirmed_status='closing_confirmed_by_peer',last_unconfirmed_status_unit=? WHERE aa_address=?",[new_unit.unit, channel.aa_address]);
					} else {
						var unconfirmedUnitsRows = await connAppDb.query("SELECT close_channel,has_definition FROM unconfirmed_units_from_peer WHERE aa_address=?", [channel.aa_address]);
						var bAlreadyBeenClosed = unconfirmedUnitsRows.some(function(row){return row.close_channel});

						if (!bHasData && (lockedChannel.status == "closed" || lockedChannel.status == "open") && // for these 2 statuses, we can take into account unconfirmed deposits since they shouldn't be refused by AA
						!bAlreadyBeenClosed && (lockedChannel.is_definition_confirmed === 1 || bHasDefinition) && // we ignore unit if a closing request happened or no pending/confirmed definition is known
						(lockedChannel.asset != 'base' || byteAmount > 10000)) { // deposit in bytes are possible only over 10000
							await connAppDb.query("INSERT  " + connAppDb.getIgnore() + " INTO unconfirmed_units_from_peer (aa_address,amount,unit,has_definition,timestamp) VALUES (?,?,?,?,?)",
							[channel.aa_address, amount, new_unit.unit, bHasDefinition ? 1 : 0, timestamp]);
							await connAppDb.query("UPDATE channels SET unconfirmed_status='opened_by_peer',last_unconfirmed_status_unit=? WHERE aa_address=?",[new_unit.unit, channel.aa_address]);
						}
					}
				}

				if (conf.isHighAvailabilityNode)
					await	connAppDb.query("DO RELEASE_LOCK(?)",[new_unit.author_address]);
				connAppDb.release();
				unlock_aa();
				eachCb();
			});
		}, function() {
			resolve();
		});
	});
}

function getJointFromCacheStorageOrHub(conn, unit){
	return new Promise(async (resolve) => {
		if (assocJointsFromPeersCache[unit])
		 return resolve(assocJointsFromPeersCache[unit]);
		if (!conf.bLight){
			return require('ocore/storage.js').readJoint(conn, unit, {
				ifFound: function(objJoint){
					return resolve(objJoint.unit);
				},
				ifNotFound: function(){
					return resolve();
				}
			});
		}
		const network = require('ocore/network.js');
		network.requestFromLightVendor('get_joint', unit,  function(ws, request, response){
			if (response.joint){
				resolve(response.joint.unit)
			} else {
				resolve();
			}
		});
		setTimeout(resolve, 1000);
	});
}

async function updateLastMci(arrUnits){
	if (conf.bLight)
		throw Error("updateLastMci called by light node");
	if (arrUnits.length === 0)
		throw Error("arrUnits for updateLastMci cannot be empty");

	const stable_units = await dagDB.query("SELECT timestamp,units.unit,main_chain_index,unit_authors.address AS author_address FROM units \n\
	CROSS JOIN unit_authors USING(unit)\n\
	WHERE units.unit IN(" + arrUnits.map(dagDB.escape).join(',') + ") AND " + await getSqlFilterForNewUnitsFromChannels() +  " GROUP BY units.unit ORDER BY main_chain_index,level ASC");

	for (var i = 0; i < stable_units.length; i++){
		var stable_unit = stable_units[i];
		if (!stable_unit.main_chain_index)
			throw Error("No MCI for stable unit");
		var payloads = await dagDB.query("SELECT payload FROM messages WHERE unit=? AND app='data' ORDER BY message_index ASC LIMIT 1", [stable_unit.unit]);
		var payload = payloads[0] ? JSON.parse(payloads[0].payload) : {};
		if (payload.event_id)
			await appDB.query("UPDATE channels SET last_updated_mci=? WHERE last_event_id>=? AND aa_address=?",
			[stable_unit.main_chain_index, payload.event_id, stable_unit.author_address])
	}
}


function treatUnitsFromAA(arrUnits){
	return new Promise(async (resolve_1) => {
		mutex.lock(['treatUnitsFromAA'], async (unlock) => {
			const unitFilter = arrUnits ? " units.unit IN(" + arrUnits.map(dagDB.escape).join(',') + ") AND " : "";
			const isStableFilter = conf.bLight ? " AND is_stable=1 AND sequence='good' " : ""; // unit from AA from can always be considered as stable on full node

			const new_units = await dagDB.query("SELECT timestamp,units.unit,main_chain_index,unit_authors.address AS author_address FROM units \n\
			CROSS JOIN unit_authors USING(unit)\n\
			WHERE "+ unitFilter + await getSqlFilterForNewUnitsFromChannels() + isStableFilter + " GROUP BY units.unit ORDER BY main_chain_index,level ASC");

			if (new_units.length === 0){
				unlock();
				console.log("nothing concerns payment channel in these units");
				return resolve_1();
			}
			console.log(new_units.length + " new_units from AA to be treated");
			for (var i = 0; i < new_units.length; i++){
				var new_unit = new_units[i];
				await treatUnitFromAA(new_unit);
				delete assocJointsFromPeersCache[new_unit];
			}
			unlock();
			return resolve_1();
		});
	});
}


function treatUnitFromAA(new_unit){
	return new Promise(async (resolve) => {
		mutex.lock([new_unit.author_address], async function(unlock_aa){
			var connAppDb = await appDB.takeConnectionFromPool();
			if (conf.isHighAvailabilityNode) {
				var connDagDb = dagDB;

				var results = await	connAppDb.query("SELECT GET_LOCK(?,1) as my_lock",[new_unit.author_address]);
				if (!results[0].my_lock || results[0].my_lock === 0){
					unlock_aa();
					connAppDb.release();
					console.log("couldn't get lock from MySQL for " + new_unit.author_address);
					return resolve();
				}
			} else {
				var connDagDb = connAppDb;
			}
			var channels = await connAppDb.query("SELECT * FROM channels WHERE aa_address=?", [new_unit.author_address]);
			if (!channels[0])
				throw Error("channel not found");
			var channel = channels[0];

			var payloads = await connDagDb.query("SELECT payload FROM messages WHERE unit=? AND app='data' ORDER BY message_index ASC LIMIT 1", [new_unit.unit]);
			var payload = payloads[0] ? JSON.parse(payloads[0].payload) : {};

			function setLastUpdatedMciAndEventIdAndOtherFields(fields){
				return new Promise(async (resolve_2) => {
					var strSetFields = "";
					if (fields)
						for (var key in fields){
							strSetFields += "," + key + "='" + fields[key] + "'";
						}
					await connAppDb.query("UPDATE channels SET last_updated_mci=?,last_event_id=?,is_definition_confirmed=1" + strSetFields + "\n\
					WHERE aa_address=? AND last_event_id<?", [new_unit.main_chain_index ? new_unit.main_chain_index : channel.last_updated_mci, payload.event_id, new_unit.author_address, payload.event_id]);
					return resolve_2();
				});
			}

			//once AA state is updated by an unit, we delete the corresponding unit from unconfirmed units table
			if (payload.trigger_unit){
				await connAppDb.query("DELETE FROM unconfirmed_units_from_peer WHERE unit=?", [payload.trigger_unit]);
			}
			//channel is open and received funding
			if (payload.open){
				await connAppDb.query("UPDATE my_deposits SET is_confirmed_by_aa=1 WHERE unit=?", [payload.trigger_unit]);
				await setLastUpdatedMciAndEventIdAndOtherFields(
					{ 
						status: "open",
						period: payload.period, 
						amount_deposited_by_peer: payload[channel.peer_address], 
						amount_deposited_by_me: payload[my_address],
						last_response_unit: new_unit.unit,
					}
				);
				if (payload[my_address] > 0)
					eventBus.emit("my_deposit_became_stable", payload[my_address], payload.trigger_unit);
				else
					eventBus.emit("peer_deposit_became_stable", payload[channel.peer_address], payload.trigger_unit);
			}

			//closing requested by one party
			if (payload.closing && channel.last_event_id < payload.event_id){ // if outdated, do nothing
				if (payload.initiated_by === my_address)
					var status = "closing_initiated_by_me";
				else {
					var status = "closing_initiated_by_peer";
					if (payload[channel.peer_address] >= channel.amount_spent_by_peer){
						confirmClosing(new_unit.author_address, payload.period, channel.overpayment_from_peer); //peer is honest, we send confirmation for closing
					} else {
						confirmClosing(new_unit.author_address, payload.period, channel.overpayment_from_peer, channel.last_message_from_peer); //peer isn't honest, we confirm closing with a fraud proof
					}
				}
				await setLastUpdatedMciAndEventIdAndOtherFields(
					{
						status: status, 
						period: payload.period, 
						close_timestamp: new_unit.timestamp,
						last_response_unit: new_unit.unit,
					});
			}
			//AA confirms that channel is closed
			if (payload.closed){
				await setLastUpdatedMciAndEventIdAndOtherFields(
					{
						status: "closed",
						is_peer_ready: 0,
						period: payload.period,
						amount_spent_by_peer: 0,
						amount_spent_by_me: 0,
						amount_deposited_by_peer: 0,
						amount_deposited_by_me: 0,
						overpayment_from_peer: 0,
						amount_possibly_lost_by_me: 0,
						my_payments_count: 0,
						peer_payments_count: 0,
						last_message_from_peer: '',
						last_response_unit: new_unit.unit,
					});
				const rows = await connDagDb.query("SELECT SUM(amount) AS amount FROM outputs WHERE unit=? AND address=?", [new_unit.unit, my_address]);
				if (payload.fraud_proof)
					eventBus.emit("channel_closed_with_fraud_proof", new_unit.author_address, rows[0] ? rows[0].amount : 0);
				else
					eventBus.emit("channel_closed", new_unit.author_address, rows[0] ? rows[0].amount : 0);
			}
			//AA refused a deposit, we still have to update flag in my_deposits table so it's not considered as pending anymore
			if (payload.refused){
				const result = await appDB.query("UPDATE my_deposits SET is_confirmed_by_aa=1 WHERE unit=?", [payload.trigger_unit]);
				if (result.affectedRows !== 0)
					eventBus.emit("refused_deposit", payload.trigger_unit);
				//await setLastUpdatedMciAndEventIdAndOtherFields({});
			}

			await	connAppDb.query("UPDATE channels SET unconfirmed_status=NULL WHERE last_unconfirmed_status_unit IN (SELECT trigger_unit FROM aa_responses WHERE response_unit=?)", [new_unit.unit]);

			if (conf.isHighAvailabilityNode)
				await	connAppDb.query("DO RELEASE_LOCK(?)",[new_unit.author_address]);
			connAppDb.release();
			unlock_aa();
			resolve();
		});
	});
}

// check if frontend authored a closing request, used only in high availability mode
function treatClosingRequests(){
	mutex.lockOrSkip(['treatClosingRequests'], async function(unlock){
		const channels = await appDB.query("SELECT last_period_closed_by_me,status,aa_address,amount_spent_by_peer,amount_spent_by_me,last_message_from_peer, period FROM channels WHERE closing_authored=1");
		if (channels.length === 0)
			return unlock();
		async.eachSeries(channels, function(channel, cb){
			closeUnderLock(row,cb);
		},
		unlock
		);
	});
}

async function closeUnderLock(channel, cb){
	if (!conf.isHighAvailabilityNode)
		throw Error("closing request not in high availability mode");

	var connAppDB = await appDB.takeConnectionFromPool();
	var results = await connAppDB.query("SELECT GET_LOCK(?,1) as my_lock",[channel.aa_address]);
	if (!results[0].my_lock || results[0].my_lock === 0){
		connAppDB.release();
		cb();
		return console.log("couldn't get lock from MySQL " + channel.aa_address);
	}
	
	if (channel.status != 'open'){
		connAppDB.release();
		cb();
		return console.log("Cannot close channel while it is not confirmed open");
	}

	const closing_period = channel.status == 'closed' ? channel.period + 1 : channel.period;

	if (channel.last_period_closed_by_me === closing_period) {
		connAppDB.release();
		cb();
		return console.log("Period already closed by me");
	}

	const payload = {
		close: 1, 
		period: closing_period
	};
	if (channel.amount_spent_by_me > 0)
		payload.transferredFromMe = channel.amount_spent_by_me;
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
		base_outputs: [{ address: channel.aa_address, amount: 10000 }]
	}

	headlessWallet.sendMultiPayment(options, async function(error, unit){
		if (error)
			console.log("error when closing channel " + error);
		else{
			await connAppDB.query("UPDATE channels SET closing_authored=0 WHERE aa_address=?", [channel.aa_address]);
			await connAppDB.query("UPDATE channels SET last_unconfirmed_status_unit=?,unconfirmed_status='closing_initiated_by_me',last_period_closed_by_me=? WHERE aa_address=?", [unit, closing_period,channel.aa_address]);
		}


		await connAppDB.query("DO RELEASE_LOCK(?)",[channel.aa_address]);
		await connAppDB.release();
		cb();
	});
}


function confirmClosing(aa_address, period, overpayment_from_peer, fraud_proof){
	mutex.lock(['confirm_' + aa_address], function(unlock){
		if (fraud_proof){
			var payload = { fraud_proof: 1, period: period, sentByPeer: JSON.parse(fraud_proof) };
		} else {
			var payload = { confirm: 1, period: period };
		}
		if (overpayment_from_peer > 0)
			payload.additionalTransferredFromMe = overpayment_from_peer;

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

		headlessWallet.sendMultiPayment(options, async function(error, unit){
			if (error)
				console.log("error when closing channel " + error);
			else {
				await appDB.query("UPDATE channels SET last_period_confirmed_by_me=? WHERE aa_address=?", [period, aa_address]);
				await appDB.query("UPDATE channels SET unconfirmed_status='closing_confirmed_by_me',last_unconfirmed_status_unit=? WHERE aa_address=?",[unit, aa_address]);
			}
			unlock();
		});
	});
}

async function confirmClosingIfTimeoutReached(){
	const current_ts = Math.round(Date.now() / 1000);
	const rows = await appDB.query("SELECT aa_address,period FROM channels WHERE period>last_period_confirmed_by_me AND \n\
	(status='closing_initiated_by_me' OR status='closing_initiated_by_peer') AND close_timestamp < (? - timeout)", [current_ts]);
	rows.forEach(function(row){
		confirmClosing(row.aa_address, row.period);
	});
}


