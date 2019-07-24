## Installation

Add it to your project:
`npm install --save https://github.com/Papabyte/aa-channels-lib.git `

## Usage:

Require the module where you need it in your project. 

`const channels = require('aa-channels-lib')`

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


exports.isHighAvaibilityNode =  false;

exports.enabledReceivers = ['http','obyte-messenger']; //configure the communication layers that can receive a message from peer
// if 'http' is present, a http server will start to listen at port httpDefaultPort
// if 'obyte-messenger' is present, messages incoming through the encypted chat layers will be treated (not possible in High availability mode)

exports.httpDefaultPort = 6800;
```

## Functions

#### createNewChannel
```javascript
channels.createNewChannel(peer, initial_amount,  function(error, aa_address, unit){

});
```
- **peer**: peering address or http address of your peer.
- **initial_amount**: initial amount in bytes you want to deposit to channel.
- **error**: if the creation is not successful, this string will indicate the reason.
- **aa_address**: address of the channel, the created channel will further be identified by this address. It has the format of an Obyte payment address like `7FLNK5AIWSYU2TVEKRW4CHCQUAKOYGWG`.
- **unit**: hash of the unit that has been broacast to create the channel and deposit initial amount on it.
The channel can be used only after some confirmation time for your deposit, listen event `my_deposit_became_stable` and watch for given `unit` to know when sending payment to channel is possible.

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
- **amount**: amount in byte you want to pay.
- **error**: if the payment is not successful, this string will indicate the reason.

#### setCallBackForPaymentReceived
```javascript
channels.setCallBackForPaymentReceived(function(amount, message_from_peer, aa_address, handle){
		return handle(response);
});
```
- **amount**: amount received in bytes
- **message_to_peer**: string, object or number received from peer alongside with the payment.
- **aa_address**: address of the channel that received payment
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
	//{"status":"open","amount_deposited_by_me":366000,"amount_spent_by_me":0,"amount_spent_by_peer":0,"free_amount":366000,"pending_deposits":0}
});
```
- **aa_address**: address of the channel you want to get status and balances
- **response**: object with the follwing attributes:
  * status: channel status
  * amount_deposited_by_me: amount you deposited to channel and that has been confirmed
  * amount_spent_by_me: total amount spent by you through channel
  * amount_spent_by_peer: total amount spent by peer through channel
  * free_amount: amount available for spending by you through channel
  * pending_deposits: total amount you have deposited but it's not confirmed yet

## Events
Require the Ocore event module where you need it in your project. 

`const eventBus = require('ocore/event_bus.js');`

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

*When the node isn't in high availability mode, there is no scope disctinction for events