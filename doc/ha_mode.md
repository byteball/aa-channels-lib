# High availability mode


#### conf.js

In addition to usual parameters, your conf.js must contain credentials for connection to an external database shared by channels watcher and front instances.

```javascript
exports.app_database = {};
exports.app_database.host = '127.0.0.1';
exports.app_database.name = 'app_db';
exports.app_database.user = 'app_db_user';
exports.app_database.password = '1234';
```

## Usage:

#### as module
Require the module where you need it in your project. 

`const channels = require('aa-channels-lib')`

Require the channels watcher in a script that runs separately

`require('aa-channels-lib/aa_watcher.js')`

#### as RPC server

Run `rpcify.js` and `aa_watcher.js` in two separate instances.

## Note

The watcher can be stopped and restarted without provoking a down time for your application.

You can run several front applications each having different http ports configured in their respective conf.js. They must connect to same database.