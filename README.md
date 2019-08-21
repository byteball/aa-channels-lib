# aa-channels-lib (testnet only for now)

This library handles a bidirectionnal payment channel through [Autonomous Agents](https://medium.com/obyte/introducing-autonomous-agents-6fe12fb12aa3)
It allows free, instant and confirmation-free offchain transactions between two parties.
Example of use cases: pay-per-call API, pay-per-time streaming...

## How does it work?

Both parties willing to transact include this module in their respective project. The library runs an headless-wallet that has to be funded prior to operation. 
The communication between them can be configured either as HTTPS or as the encrypted Obyte chat layer.
- Encrypted chat: virtually no setup but has some latency, is not adapted for consequent volume of data and is hub-dependent.
- HTTPS: a party that wants to receive payment has to setup an Nginx proxy but the communication is direct, very fast and the application can be infinitely scalable (see High Availability node below)

One peer initiates the creation with:
```javascript
channels.createNewChannel(peer, initial_amount, options, function(error, aa_address, unit){

});
```

**peer** is an url or a pairing address where the peer can be reached, if the peer acknowledged the creation, the definition of the AA is broadcast and immediately funded with initial deposit. **aa_address** is then returned by the function and is to be saved as it will used to identify channel for further operation.
Once the payment channel is opened and confirmed by Obyte network, transactions can begin.

One peer wanting to send an offchain payment uses this function:

```javascript
channels.sendMessageAndPay(aa_address, message_to_peer, amount, function(error, response){
	if (error)
		return console.log(error);
	else
		return console.log(response);
});
```
**aa_address** is the address of the channel provided during its creation, **message_to_peer** is anything that can be parsed in JSON (string, number or object) and that you want to transmit to your peer, **amount** is the amount of your payment and **function** is a callback that will be returned with **error** or **response** from your peer.

You can set a function to be executed when you receive an offchain payment:
```javascript
	channels.setCallBackForPaymentReceived(function(amount, asset, message, peer_address, handle){
		if (message == "thanks me")
			return handle(null, "Thank you " + peer_address + " I received you payment of " + amount + " " + asset);
		else if (message == "send me an error")
			return handle("this is an error");
	});

```
The response can be a number, a string or an object, and will be forwarded to the payer.


The channel can be closed an anytime by one of the party with:
```javascript
channels.close(aa_address, function(error){
	if (error)
		console.error(error);
});
```
After a confirmation by the network and a maximum timeout of 5 minutes, you headless wallet will receive a payment calculated as follow:
**amount received** = **total amount deposited by you to the channel** - **total amount paid to your peer** + **total payment received from your peer**

All functions and events available are documented there: https://github.com/Papabyte/aa-channels-lib/blob/master/doc/reference.md

## High Avaibility mode
A node only destinated to receive payment can run in high-availability mode. In this case, the front service that handles the requests from clients is separated from a background service that runs the headless wallet. Several front services can run in parallel to serve clients even when the background goes down for some time (like for being updated). That greatly helps the scalability of your business.

The exact setup depends of you need but you will likely use:
- a load balancer that will redirect https requests to different front service instances.
- an external MySQL database, ideally a fault tolerant cluster, to which front app and background app can connect to.

Check specific documentation there: https://github.com/Papabyte/aa-channels-lib/blob/master/doc/ha_mode.md