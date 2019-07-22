## Installation

Add `"aa-channels": "git+https://github.com/papabyte/aa-channel-lib.git"` to dependencies in the package.json of your project

`npm install`

## Initialization

`const channels = require('aa-channels')`


## Functions

```
channels.createNewChannel(url or pairing address, initial deposit, {
		ifOK: function(aa_address){
			//aa_address is the address of the created channel
		},
		ifError: function(error){
		}
	}
```

```
channels.sendMessageAndPay(aa_address, message to peer, amount ,function(error, response){
	if (error)
		return console.log(error);
	else
		return console.log(response);
});
```

```
channels.setCallBackForPaymentReceived(function(amount, message from peer, peer address, handle){
		return handle(object returned to peer);
});
```

```
channels.deposit(aa_address, amount, function(error){

});
```

```
channels.close(aa_address, function(error){
	
});
```

```
channels.getBalancesAndStatus(aa_address, function(balances){
	//{"status":"open","amount_deposited_by_me":366000,"amount_spent_by_me":0,"amount_spent_by_peer":0,"free_amount":366000,"pending_deposits":0}
});
```

## Events
Add `"ocore": "git+https://github.com/byteball/ocore.git",` to dependencies in the package.json of your project

`const eventBus = require('ocore/event_bus.js');`

#### front app scope*
```
eventBus.on("channel_created_by_peer", function(peer payment address, aa_address){ 
	
});
```

```
eventBus.on("channel_refilled", function(aa_address, amount){
	
});
```


#### aa watcher scope*
```
eventBus.on("my_deposit_became_stable", function(amount, deposit unit){
	
});
```

```
eventBus.on("peer_deposit_became_stable",  function(amount,  deposit unit){

});
```

```
eventBus.on("channel_closed_with_fraud_proof", function(aa_address, amount received at closing){
	
});
```

```
eventBus.on("channel_closed", function(aa_address, amount received at closing){
	
});

```

```
eventBus.on("refused_deposit",function(deposit unit){
	
};
```

*When the node isn't in high availability mode, there is no scope disctinction for events