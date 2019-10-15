const rpcify = require('rpcify');
const frontApp = require('./front_app.js');
const eventBus = require('ocore/event_bus.js')

// start listening on RPC port
rpcify.listen(6333, '127.0.0.1');

// expose some functions via RPC
rpcify.expose(frontApp.setAutoRefill);
rpcify.expose(frontApp.createNewChannel);
rpcify.expose(frontApp.deposit);
rpcify.expose(frontApp.sendMessageAndPay);
rpcify.expose(frontApp.close);
rpcify.expose(frontApp.getBalancesAndStatus);
rpcify.expose(frontApp.verifyPaymentPackage);
rpcify.expose(frontApp.createPaymentPackage);

rpcify.exposeEvent(eventBus, "my_deposit_became_stable");
rpcify.exposeEvent(eventBus, "peer_deposit_became_stable");
rpcify.exposeEvent(eventBus, "channel_closed_with_fraud_proof");
rpcify.exposeEvent(eventBus, "channel_closed");
rpcify.exposeEvent(eventBus, "refused_deposit");
rpcify.exposeEvent(eventBus, "channel_created_by_peer");
rpcify.exposeEvent(eventBus, "channel_refilled");
rpcify.exposeEvent(eventBus, "payment_received");