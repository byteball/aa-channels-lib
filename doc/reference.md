## Configuration

Add a conf.js in the root directory of your project modified according to your desired configuration

```javascript
exports.bLight = true; // change to false to run as full node
exports.bSingleAddress = true; //should always be true

exports.WS_PROTOCOL = "wss://";
exports.hub = process.env.testnet ? 'obyte.org/bb-test' : 'obyte.org/bb';
exports.deviceName = 'AA-channel-application';
exports.permanent_pairing_secret = '0000';
exports.control_addresses = [''];

exports.minChannelTimeoutInSecond = 600;  // timeout value under which channel creation request will be refused
exports.maxChannelTimeoutInSecond = 1000; // timeout value above which channel creation request will be refused
exports.defaultTimeoutInSecond = 600;. // default timeout value for channels created by me

exports.unconfirmedAmountsLimitsByAssetOrChannel = { // settings for accepting payments backed by unconfirmed channel and/or deposit
	"base" : {
		max_unconfirmed_by_asset : 1e6, // won't allow payment if current total unconfirmed over this amount
		max_unconfirmed_by_channel : 1e6, // won't allow payment if total unconfirmed for a channel  is over this amount
		minimum_time_in_second : 5 // won't allow payment if at least this time didn't elapse since peer's deposit
	},
	"VVjz0rDamfpjpwlRUWoffMxu5gkl/3mGerXNHsNuV7Q=" : {
		max_unconfirmed_by_asset : 10000,
		max_unconfirmed_by_channel : 5000,
		minimum_time_in_second : 2
	}
}

exports.isHighAvailabilityNode =  false;

exports.enabledReceivers = ['http','obyte-messenger']; //configure the communication layers that can receive a message from peer
// if 'http' is present, a http server will start to listen at port httpDefaultPort
// if 'obyte-messenger' is present, messages incoming through the encypted chat layers will be treated (not possible in High availability mode)

exports.httpDefaultPort = 6800;
```

## Functions

#### createNewChannel
```javascript
channels.createNewChannel(peer, initial_amount, options, function(error, aa_address, unit){

});
```
- **peer**: peering address or http address of your peer.
- **initial_amount**: initial amount in asset or bytes you want to deposit to channel.
- **options** object with the follwing attributes:
  * timeout (optional): timeout in seconds for the channel.
  * asset (optional): asset used for all transactions with this channel, if null bytes will be used.
  * auto_refill_threshold (optional): amount that is automatically refilled if available amount on channel goes below a threshold.
  * auto_refill_amount (optional): amount available amount under which the channel will be automatically refilled.
  * salt (optional): string that will be placed in the AA definition with no other purpose that generating a different AA address than other channels created with same peer addresses. It's especially useful when parties want to transact using several channels in parallel. If set to true, a random 50 characters salt with be used. 
- **error**: if the creation is not successful, this string will indicate the reason.
- **aa_address**: address of the channel, the created channel will further be identified by this address. It has the format of an Obyte payment address like `7FLNK5AIWSYU2TVEKRW4CHCQUAKOYGWG`.
- **unit**: hash of the unit that has been broacast to create the channel and deposit initial amount on it.
The channel can be used only after some confirmation time for your deposit, listen event `my_deposit_became_stable` and watch for given `unit` to know when sending payment to channel is possible.

#### setAutoRefill
```javascript
channels.setAutoRefill(aa_address, auto_refill_amount, auto_refill_threshold, function(error){

});
```
- **aa_address**: address of the channel obtained through `createNewChannel` function or `channel_created_by_peer` event.
- **auto_refill_amount**: amount that is automatically refilled if available amount on channel goes below a threshold.
- **auto_refill_threshold**: amount available amount under which the channel will be automatically refilled.
- **error**: error returned if setting failed.

#### sendMessageAndPay
```javascript
channels.sendMessageAndPay(aa_address, message_to_peer, amount, function(error, response){
	if (error)
		return console.log(error);
	else
		return console.log(response);
});
```
- **aa_address**: address of the channel obtained through `createNewChannel` function or `channel_created_by_peer` event.
- **message_to_peer**: string, object or number sent to peer alongside with the payment. It's likely be used to indicate what the payment is destinated to.
- **amount**: amount in bytes or assets you want to pay.
- **error**: error returned by peer or if payment couldn't have been sent

#### setCallBackForPaymentReceived
```javascript
channels.setCallBackForPaymentReceived(function(amount, asset, message_from_peer, aa_address, handle){
		return handle(error, response);
});
```
- **amount**: amount received in bytes or assets
- **asset**: asset unit for payment received in assets or 'base' for bytes
- **message_to_peer**: string, object or number received from peer alongside with the payment.
- **aa_address**: address of the channel that received payment
- **error**: will be returned to peer if not null
- **response**: your response to the peer, will be transmitted back through http response or obyte message.

#### deposit
```javascript
channels.deposit(aa_address, amount, function(error, unit){

});
```
- **aa_address**: address of the channel you want to fund
- **amount**: amount you want to deposit to channel
- **error**: if the deposit is not successful, this string will indicate the reason.
- **unit**: hash of the unit corresponding to your deposit to channel.
This additional funding can be used only after some confirmation time, listen event `my_deposit_became_stable` and watch for the given `unit` to know when this funding is available for your payment through this channel.

#### close
```javascript
channels.close(aa_address, function(error){
	
});
```
- **aa_address**: address of the channel you want to close
- **error**: if the closing is not successful, this string will indicate the reason.
After you authored the closing of a channel, you cannot send payment through it anymore and any payment received will be refused. You can listen the event `channel_closed` to know when the channel is effectively closed and your remaining balance has been refunded.

#### getBalancesAndStatus
```javascript
channels.getBalancesAndStatus(aa_address, function(response){
	//{"status":"open","amount_deposited_by_me":366000,"amount_spent_by_me":0,"amount_spent_by_peer":0,"free_amount":366000,"my_deposits":0}
});
```
- **aa_address**: address of the channel you want to get status and balances
- **response**: object with the follwing attributes:
  * status: channel status
  * amount_deposited_by_me: amount you deposited to channel and that has been confirmed
  * amount_spent_by_me: total amount spent by you through channel
  * amount_spent_by_peer: total amount spent by peer through channel
  * free_amount: amount available for spending by you through channel
  * my_deposits: total amount you have deposited but it's not confirmed yet

#### getPaymentPackage
```javascript
channels.getPaymentPackage(payment_amount, aa_address, function(error, objSignedPackage){

});
```
- **payment_amount**: amount you want to send in bytes or asset (according to channel's parameter)
- **aa_address**: address of the channel you want to use to send payment
- **error**: if package couldn't be obtained, this string will indicate the reason.
- **objSignedPackage**: object to be transmitted to your peer to pay him

#### verifyPaymentPackage
```javascript
channels.verifyPaymentPackage(objSignedPackage, function(error, payment_amount, asset, aa_address){
});
```
- **objSignedPackage**: object obtained from peer
- **error**: if verification failed, this string will indicate the reason.
- **payment_amount**: amount received
- **asset**: asset of payment received
- **aa_address**: address of the channel that was used

## Events

#### front app scope*
```javascript
eventBus.on("channel_created_by_peer", function(peer payment address, aa_address){ 
	
});
```

```javascript
eventBus.on("channel_refilled", function(aa_address, amount){
	
});
```


#### aa watcher scope*
```javascript
eventBus.on("my_deposit_became_stable", function(amount, unit){
	
});
```

```javascript
eventBus.on("peer_deposit_became_stable",  function(amount,  deposit unit){

});
```

```javascript
eventBus.on("channel_closed_with_fraud_proof", function(aa_address, amount received at closing){
	
});
```

```javascript
eventBus.on("channel_closed", function(aa_address, amount received at closing){
	
});

```

```javascript
eventBus.on("refused_deposit",function(deposit unit){
	
};
```

*When the node isn't in high availability mode, there is no scope distinction for events