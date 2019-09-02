var rpcify = require('rpcify');
var frontApp = require('./front_app.js');

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
rpcify.expose(frontApp.getPaymentPackage);