const objectHash = require('ocore/object_hash.js');
const conf = require('ocore/conf.js');


function getAddressAndParametersForAA(addressA, addressB, salt, version = conf.aa_version){

	const arrDefinition = ['autonomous agent', {
		init: `{
			$close_timeout = 300;
			$salt = '${salt}';
			$addressA = '${addressA}';
			$addressB = '${addressB}';
			$bFromA = (trigger.address == $addressA);
			$bFromB = (trigger.address == $addressB);
			$bFromParties = ($bFromA OR $bFromB);
			if ($bFromParties)
				$party = $bFromA ? 'A' : 'B';
		}`,
		messages: {
			cases: [
				{ // one party fills or refills the AA
					if: `{ $bFromParties AND trigger.output[[asset=base]] >= 1e5 }`,
					init: `{
						if (var['close_initiated_by']){
							$refused=1;
						} else {
						if (!var['period'])
							$period = 1;
						else
							$period = var['period'];
						}
					}`,
					messages: [{
						if:"{!$refused}", //we broadcast an unit indicating the new state of AA if deposit is accepted
						app: 'data',
						payload: {
							open: 1,
							period: "{$period}",
							"{$addressA}":"{var['balanceA'] + ($party == 'A' ? trigger.output[[asset=base]] : 0)}",
							"{$addressB}":"{var['balanceB'] + ($party == 'B' ? trigger.output[[asset=base]] : 0)}",
							event_id :"{var['event_id'] otherwise 1}",
							trigger_unit: "{trigger.unit}"
						}
					},
					{
						if:"{$refused}", //we add data to inform that deposit is refused
						app: 'data',
						payload: {
							refused: 1,
							trigger_unit: "{trigger.unit}",
							event_id :"{var['event_id'] otherwise 1}",
						}
					},
					{
						if:"{$refused}", //we refund sender if deposit is refused
						app: 'payment',
						payload: {
							asset: "base",
							outputs: [
								{address: "{trigger.address}", amount: "{trigger.output[[asset=base]]}"}
							]
						}
					},
						{
							app: 'state',
							state: `{
								if (!var['event_id'])
									var['event_id'] = 2;
								else
									var['event_id'] += 1;
								if (!$refused){
									if (!var['period'])
									var['period'] = 1;
									$key = 'balance' || $party;
									var[$key] += trigger.output[[asset=base]];
								}
							}`
						}
					]
				},
				{ // start closing
					if: `{ $bFromParties AND trigger.data.close AND !var['close_initiated_by'] }`,
					init: `{
						if (trigger.data.period != var['period'])
							bounce('wrong period');
						$transferredFromMe = trigger.data.transferredFromMe otherwise 0;
						if ($transferredFromMe < 0)
									bounce('bad amount spent by me: ' || $transferredFromMe);
						if (trigger.data.sentByPeer){
							if (trigger.data.sentByPeer.signed_message.channel != this_address)
								bounce('signed for another channel');
							if (trigger.data.sentByPeer.signed_message.period != var['period'])
								bounce('signed for a different period of this channel');
							if (!is_valid_signed_package(trigger.data.sentByPeer, $bFromB ? $addressA : $addressB))
								bounce('invalid signature by peer');
							$transferredFromPeer = trigger.data.sentByPeer.signed_message.amount_spent;
							if ((!$transferredFromPeer AND $transferredFromPeer !=0) || $transferredFromPeer < 0)
								bounce('bad amount spent by peer: ' || $transferredFromPeer);
						}
						else
							$transferredFromPeer = 0;
					}`,
					messages: [
							{
								app: 'data', //we broadcast an unit indicating the channel has received a closing request
								payload: {
									closing: 1,
									period: "{var['period']}",
									initiated_by: "{trigger.address}",
									"{$addressA}": "{ $bFromA ? $transferredFromMe : $transferredFromPeer}",
									"{$addressB}": "{ $bFromB ? $transferredFromMe : $transferredFromPeer}",
									event_id :"{var['event_id'] otherwise 1}"
								}
							},
							{
							app: 'state',
							state: `{
								var['spentByA'] = $bFromA ? $transferredFromMe : $transferredFromPeer;
								var['spentByB'] = $bFromB ? $transferredFromMe : $transferredFromPeer;
								$finalBalanceA = var['balanceA'] - var['spentByA'] + var['spentByB'];
								$finalBalanceB = var['balanceB'] - var['spentByB'] + var['spentByA'];
								if ($finalBalanceA < 0 OR $finalBalanceB < 0)
									bounce('one of the balances would become negative');
								var['close_initiated_by'] = $party;
								var['close_start_ts'] = timestamp;
								if (!var['event_id'])
									var['event_id'] = 2;
								else
									var['event_id'] += 1;
							}`
						},
					]
				},
				{ // confirm closure
					if: `{ trigger.data.confirm AND var['close_initiated_by'] }`,
					init: `{
						if (!($bFromParties AND var['close_initiated_by'] != $party OR timestamp > var['close_start_ts'] + $close_timeout))
							bounce('too early');
						if (trigger.data.period != var['period'])
							bounce('wrong period');
						$finalBalanceA = var['balanceA'] - var['spentByA'] + var['spentByB'];
						$finalBalanceB = var['balanceB'] - var['spentByB'] + var['spentByA'];
					}`,
					messages: [
						{
							app: 'payment',
							payload: {
								asset: "base",
								outputs: [
									// fees are paid by the larger party, its output is send-all
									// this party also collects the accumulated 10Kb bounce fees
									{address: "{$addressA}", amount: "{ $finalBalanceA < $finalBalanceB ? $finalBalanceA : '' }"},
									{address: "{$addressB}", amount: "{ $finalBalanceA >= $finalBalanceB ? $finalBalanceB : '' }"},
								]
							}
						},
						{
							app: 'data',  //we add data to indicate the channel is effectively closed
							payload: {
								closed: 1,
								period: "{var['period']}",
								event_id :"{var['event_id']}"
							}
						},
						{
							app: 'state',
							state: `{
								var['period'] += 1;
								var['close_initiated_by'] = false;
								var['close_start_ts'] = false;
								var['balanceA'] = false;
								var['balanceB'] = false;
								var['spentByA'] = false;
								var['spentByB'] = false;
								var['event_id'] += 1;
							}`
						},
					]
				},
				{ // fraud proof
					if: `{ trigger.data.fraud_proof AND var['close_initiated_by'] AND trigger.data.sentByPeer }`,
					init: `{
						$bInitiatedByA = (var['close_initiated_by'] == 'A');
						if (trigger.data.sentByPeer.signed_message.channel != this_address)
							bounce('signed for another channel');
						if (trigger.data.sentByPeer.signed_message.period != var['period'])
							bounce('signed for a different period of this channel');
						if (!is_valid_signed_package(trigger.data.sentByPeer, $bInitiatedByA ? $addressA : $addressB))
							bounce('invalid signature by peer');
						$transferredFromPeer = trigger.data.sentByPeer.signed_message.amount_spent;
						if ($transferredFromPeer < 0)
							bounce('bad amount spent by peer: ' || $transferredFromPeer);
						$transferredFromPeerAsClaimedByPeer = var['spentBy' || ($bInitiatedByA ? 'A' : 'B')];
						if ($transferredFromPeer <= $transferredFromPeerAsClaimedByPeer)
							bounce("the peer didn't lie in his favor");
					}`,
					messages: [
						{
							app: 'payment',
							payload: {
								asset: "base",
								outputs: [
									// send all
									{address: "{trigger.address}"},
								]
							}
						},
						{
							app: 'data',  //we add data to indicate the channel has been closed with a fraud proof submitted
							payload: {
								closed: 1,
								fraud_proof: 1,
								period: "{var['period']}",
								event_id :"{var['event_id']}"
							},
						},
						{
							app: 'state',
							state: `{
								var['period'] += 1;
								var['close_initiated_by'] = false;
								var['close_start_ts'] = false;
								var['balanceA'] = false;
								var['balanceB'] = false;
								var['spentByA'] = false;
								var['spentByB'] = false;
								if (!var['event_id'])
									var['event_id'] = 1;
								else
									var['event_id'] += 1;
							}`
						},

					]
				},
			]
		}
	}];

	const aa_address = objectHash.getChash160(arrDefinition);
	return {aa_address: aa_address, address_a: addressA, address_b: addressB,  version: version, salt: salt, arrDefinition: arrDefinition};
}

exports.getAddressAndParametersForAA = getAddressAndParametersForAA;