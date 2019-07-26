/*jslint node: true */
"use strict";
const conf = require('ocore/conf.js');
const mysql = require('mysql');
const mysql_pool_constructor = require('ocore/mysql_pool.js');

if (typeof conf.app_database != 'object')
	throw Error("app_database not configured in conf.js");

const pool  = mysql.createPool({
	connectionLimit : conf.app_database.max_connections,
	host     : conf.app_database.host,
	user     : conf.app_database.user,
	password : conf.app_database.password,
	charset  : 'UTF8MB4_UNICODE_520_CI', // https://github.com/mysqljs/mysql/blob/master/lib/protocol/constants/charsets.js
	database : conf.app_database.name
});

module.exports = mysql_pool_constructor(pool);