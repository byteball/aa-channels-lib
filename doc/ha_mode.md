## High availability mode


#### conf.js

conf.js must contain credentials for connection to an external database shared by channels watcher and front instances.

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

exports.isHighAvailabilityNode =  true;

exports.enabledReceivers = ['http']; //configure the communication layers that can receive a message from peer
// if 'http' is present, a http server will start to listen at port httpDefaultPort

exports.httpDefaultPort = 6800;

exports.app_database = {};
exports.app_database.host = '127.0.0.1';
exports.app_database.name = 'app_db';
exports.app_database.user = 'app_db_user';
exports.app_database.password = '1234';
```

# Usage:

Require the module where you need it in your project. 

`const channels = require('aa-channels-lib')`

Require the channels watcher in a script that runs separately

`require('aa-channels-lib/aa_watcher.js')`

The watcher can be stopped and restarted without provoking a down time for your application.

You can run several front applications each having different http ports configured in their respective conf.js. They must connect to same database.