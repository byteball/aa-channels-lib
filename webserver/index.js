const conf = require('ocore/conf.js');
const frontApp = require('../front_app.js');
const express = require('express')
const path = require('path');

if (conf.isHighAvailabilityNode){ // in high availability mode, an external MySQL DB is to be used
	var appDB = require('./modules/external_db.js');
} else {
	var appDB = require('ocore/db.js');
}

function start(){

	const app = express();
	const server = require('http').Server(app);

//	app.use(cookieParser());
//	app.use(bodyParser.urlencoded({ extended: false }));

	// view engine setup
	app.set('views', path.join(__dirname, 'views'));
	app.set('view engine', 'ejs');
	app.use(express.urlencoded());

	app.get('/', async (req, res) => {
		const channels = await appDB.query("SELECT unconfirmed_status,status,amount_spent_by_me,amount_spent_by_peer,asset,peer_address,channels.aa_address,\n\
		amount_deposited_by_me,my_payments_count,peer_payments_count,close_timestamp,\n\
		(SELECT amount FROM payments_sent WHERE payments_sent.aa_address=channels.aa_address ORDER BY ID DESC LIMIT 1) AS last_payment_sent_amount,\n\
		(SELECT date FROM payments_sent WHERE payments_sent.aa_address=channels.aa_address ORDER BY ID DESC LIMIT 1) AS last_payment_sent_date,\n\
		last_response_unit,last_unconfirmed_status_unit,\n\
		IFNULL((SELECT SUM(amount) FROM my_deposits WHERE my_deposits.aa_address=channels.aa_address AND is_confirmed_by_aa=0),0) AS my_pending_deposit\n\
		FROM channels LEFT JOIN unconfirmed_units_from_peer ON unconfirmed_units_from_peer.aa_address=unconfirmed_units_from_peer.aa_address\n\
		");

		res.render('index.ejs', {
			channels,
			conf
		});
	});

	app.post('/', (req, res) => {
		frontApp.close(req.body.aa_address, function(){
			return res.redirect('/');
		});
	});

	server.listen(conf.webServerPort, () => {
		console.log(`== server started listening on ${conf.webServerPort} port`);
	});


}


start();
