const path = require('path')
const { Testkit, Utils } = require('aa-testkit')
const { Network } = Testkit()

describe('open-closed normally confirmed, open-closed timeout, open-closed fraud proof', function () {
	this.timeout(120 * 1000)

	const close_timeout = 2000;
	var event_id = 0;

	before(async () => {
		this.network = await Network.create()
			.with.agent({ base_aa: path.join(__dirname, '../channels_base_aa.ojson') })
			.with.wallet({ alice: 10e9 })
			.with.wallet({ bob: 10e9 })
			.with.explorer()
			.run()

		this.aliceAddress = await this.network.wallet.alice.getAddress();
		this.bobAddress = await this.network.wallet.bob.getAddress();
	})

	it('Deploy AA', async () => {
		const {address, unit, error } = await this.network.deployer.deployAgent({
			base_aa: this.network.agent.base_aa,
				params:	{
					addressA: this.aliceAddress,
					addressB: this.bobAddress,
					asset: 'base',
					timeout: close_timeout
				}
			});
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		this.aa_address = address;
		await this.network.witnessUntilStable(unit)

	}).timeout(15000)

	const depositedByAlicePeriod_1 = 2e9;
	it('Alice opens channel', async () => {
		const { unit, error } = await this.network.wallet.alice.sendBytes({
			toAddress: this.aa_address,
			amount: depositedByAlicePeriod_1,
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.open).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(1)
		expect(dataPayload[this.aliceAddress]).to.be.equal(depositedByAlicePeriod_1)
		expect(dataPayload[this.bobAddress]).to.be.equal(0)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)
		expect(dataPayload.trigger_unit).to.be.equal(unit)

		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.equal(depositedByAlicePeriod_1)

	}).timeout(15000)

	const depositedByBobPeriod_1 = 1e9;
	it('Bob funds channel', async () => {
		const { unit, error } = await this.network.wallet.bob.sendBytes({
			toAddress: this.aa_address,
			amount: depositedByBobPeriod_1,
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.open).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(1)
		expect(dataPayload[this.aliceAddress]).to.be.equal(depositedByAlicePeriod_1)
		expect(dataPayload[this.bobAddress]).to.be.equal(depositedByBobPeriod_1)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)
		expect(dataPayload.trigger_unit).to.be.equal(unit)

		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.equal(depositedByAlicePeriod_1)
		expect(vars['balanceB']).to.be.equal(depositedByBobPeriod_1)

	}).timeout(15000)

	const amountSpentByAlicePeriod_1 = 150000;
	const amountSpentByBobPeriod_1 = 612000;
	
	it('Bob closes channel wrong period', async () => {
		const aliceMessage = { 
			amount_spent: amountSpentByAlicePeriod_1, 
			period: 1,
			aa_address: this.aa_address 
		};

		const { signedPackage: objPackageSignedByAlice } = await this.network.wallet.alice.signMessage(aliceMessage, this.aliceAddress);

		const { unit, error } = await await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				close: 1,
				period: 3,
				transferredFromMe: amountSpentByBobPeriod_1,
				sentByPeer: objPackageSignedByAlice
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.equal('wrong period');
		expect(response.bounced).to.be.true
		
	}).timeout(15000)

	it('Bob closes channel wrong signed period', async () => {
		const aliceMessage = { 
			amount_spent: amountSpentByAlicePeriod_1, 
			period: 18,
			aa_address: this.aa_address 
		};

		const { signedPackage: objPackageSignedByAlice } = await this.network.wallet.alice.signMessage(aliceMessage, this.aliceAddress);

		const { unit, error } = await await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				close: 1,
				period: 1,
				transferredFromMe: amountSpentByBobPeriod_1,
				sentByPeer: objPackageSignedByAlice
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.equal('signed for a different period of this channel');
		expect(response.bounced).to.be.true
		
	}).timeout(15000)

	it('Bob closes channel', async () => {
		const aliceMessage = { 
			amount_spent: amountSpentByAlicePeriod_1, 
			period: 1,
			aa_address: this.aa_address 
		};

		const { signedPackage: objPackageSignedByAlice } = await this.network.wallet.alice.signMessage(aliceMessage, this.aliceAddress);

		const { unit, error } = await await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				close: 1,
				period: 1,
				transferredFromMe: amountSpentByBobPeriod_1,
				sentByPeer: objPackageSignedByAlice
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.closing).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(1)
		expect(dataPayload.initiated_by).to.be.equal(this.bobAddress)
		expect(dataPayload[this.aliceAddress]).to.be.equal(amountSpentByAlicePeriod_1)
		expect(dataPayload[this.bobAddress]).to.be.equal(amountSpentByBobPeriod_1)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)
		expect(dataPayload.trigger_unit).to.be.equal(unit)

		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.equal(depositedByAlicePeriod_1)
		expect(vars['balanceB']).to.be.equal(depositedByBobPeriod_1)
		expect(vars['spentByA']).to.be.equal(amountSpentByAlicePeriod_1)
		expect(vars['spentByB']).to.be.equal(amountSpentByBobPeriod_1)
		
	}).timeout(15000)

	it('Bob tries to confirm', async () => {

		const { unit, error } = await await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				confirm: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.equal('too early')
		expect(response.bounced).to.be.true
		
	}).timeout(15000)



	it('Bob tries to deposit', async () => {

		const { unit, error } = await this.network.wallet.bob.sendBytes({
			toAddress: this.aa_address,
			amount: 50000,
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.refused).to.be.equal(1)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)
		expect(Utils.hasOnlyTheseExternalPayments(unitObj,[{address: this.bobAddress, amount: 50000 - 10000}])).to.be.true

		
	}).timeout(15000)

	it('Alice confirms', async () => {

		const { unit, error } = await await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				period: 1,
				confirm: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.closed).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(1)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)

		const payments = Utils.getExternalPayments(unitObj)
		expect(payments).to.have.lengthOf(2)

		const paymentToAlice = payments.find(m => m.address === this.aliceAddress)
		const paymentToBob = payments.find(m => m.address === this.bobAddress)

		expect(paymentToAlice.amount).to.be.above(depositedByAlicePeriod_1 - amountSpentByAlicePeriod_1 + amountSpentByBobPeriod_1 - 10000)
		expect(paymentToBob.amount).to.be.equal(depositedByBobPeriod_1 - amountSpentByBobPeriod_1 + amountSpentByAlicePeriod_1 + 10000)


		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.undefined
		expect(vars['balanceB']).to.be.undefined
		expect(vars['spentByA']).to.be.undefined
		expect(vars['spentByB']).to.be.undefined
		expect(vars['close_initiated_by']).to.be.undefined
		expect(vars['close_start_ts']).to.be.undefined
		
	}).timeout(15000)

	const depositedByAlicePeriod_2 = 3e9;
	const depositedByBobPeriod_2 = 0;

	it('Alice opens channel', async () => {
		const { unit, error } = await this.network.wallet.alice.sendBytes({
			toAddress: this.aa_address,
			amount: depositedByAlicePeriod_2,
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.open).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(2)
		expect(dataPayload[this.aliceAddress]).to.be.equal(depositedByAlicePeriod_2)
		expect(dataPayload[this.bobAddress]).to.be.equal(0)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)
		expect(dataPayload.trigger_unit).to.be.equal(unit)

		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.equal(depositedByAlicePeriod_2)

	}).timeout(15000)



	const amountSpentByAlicePeriod_2 = 652000;
	const amountSpentByBobPeriod_2 = 0;
	

	it('Bob closes channel', async () => {
		const aliceMessage = { 
			amount_spent: amountSpentByAlicePeriod_2, 
			period: 2,
			aa_address: this.aa_address 
		};

		const { signedPackage: objPackageSignedByAlice } = await this.network.wallet.alice.signMessage(aliceMessage, this.aliceAddress);

		const { unit, error } = await await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				close: 1,
				period: 2,
				transferredFromMe: amountSpentByBobPeriod_2,
				sentByPeer: objPackageSignedByAlice
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.closing).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(2)
		expect(dataPayload.initiated_by).to.be.equal(this.bobAddress)
		expect(dataPayload[this.aliceAddress]).to.be.equal(amountSpentByAlicePeriod_2)
		expect(dataPayload[this.bobAddress]).to.be.equal(amountSpentByBobPeriod_2)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)
		expect(dataPayload.trigger_unit).to.be.equal(unit)

		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.equal(depositedByAlicePeriod_2)
		expect(vars['balanceB']).to.be.undefined
		expect(vars['spentByA']).to.be.equal(amountSpentByAlicePeriod_2)
		expect(vars['spentByB']).to.be.equal(amountSpentByBobPeriod_2)
		
	}).timeout(15000)

	it('Bob tries to confirm', async () => {

		const { unit, error } = await await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				period: 2,
				confirm: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.equal('too early')
		expect(response.bounced).to.be.true
		
	}).timeout(15000)

	const additionalTransferredFromBob = 6324;
	it('Bob confirms after timeout', async () => {
		await this.network.timetravel({ shift: close_timeout+'s' })
		const { unit, error } = await await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				period: 2,
				additionnalTransferredFromMe: additionalTransferredFromBob,
				confirm: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.closed).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(2)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)

		const payments = Utils.getExternalPayments(unitObj)
		expect(payments).to.have.lengthOf(2)

		const paymentToAlice = payments.find(m => m.address === this.aliceAddress)
		const paymentToBob = payments.find(m => m.address === this.bobAddress)

		expect(paymentToAlice.amount).to.be.above(depositedByAlicePeriod_2 - amountSpentByAlicePeriod_2 + amountSpentByBobPeriod_2 - 10000 + additionalTransferredFromBob)
		expect(paymentToBob.amount).to.be.equal(depositedByBobPeriod_2 - amountSpentByBobPeriod_2 + amountSpentByAlicePeriod_2 + 10000 - additionalTransferredFromBob)


		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.undefined
		expect(vars['balanceB']).to.be.undefined
		expect(vars['spentByA']).to.be.undefined
		expect(vars['spentByB']).to.be.undefined
		expect(vars['close_initiated_by']).to.be.undefined
		expect(vars['close_start_ts']).to.be.undefined

		
	}).timeout(15000)


	const depositedByAlicePeriod_3 = 5e9;
	const depositedByBobPeriod_3 = 3.5e9;

	it('Alice opens channel', async () => {
		const { unit, error } = await this.network.wallet.alice.sendBytes({
			toAddress: this.aa_address,
			amount: depositedByAlicePeriod_3,
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.open).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(3)
		expect(dataPayload[this.aliceAddress]).to.be.equal(depositedByAlicePeriod_3)
		expect(dataPayload[this.bobAddress]).to.be.equal(0)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)
		expect(dataPayload.trigger_unit).to.be.equal(unit)

		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.equal(depositedByAlicePeriod_3)

	}).timeout(15000)

	it('Bob funds channel', async () => {
		const { unit, error } = await this.network.wallet.bob.sendBytes({
			toAddress: this.aa_address,
			amount: depositedByBobPeriod_3,
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.open).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(3)
		expect(dataPayload[this.aliceAddress]).to.be.equal(depositedByAlicePeriod_3)
		expect(dataPayload[this.bobAddress]).to.be.equal(depositedByBobPeriod_3)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)
		expect(dataPayload.trigger_unit).to.be.equal(unit)

		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.equal(depositedByAlicePeriod_3)
		expect(vars['balanceB']).to.be.equal(depositedByBobPeriod_3)

	}).timeout(15000)

	const amountSpentByAlicePeriod_3 = 652000;
	const amountSpentByBobPeriod_3 = 12000056;
	

	it('Alice closes channel', async () => {
		const bobMessage = { 
			amount_spent: amountSpentByBobPeriod_3, 
			period: 3,
			aa_address: this.aa_address 
		};

		const { signedPackage: objPackageSignedByBob } = await this.network.wallet.bob.signMessage(bobMessage, this.bobAddress);

		const { unit, error } = await await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				close: 1,
				period: 3,
				transferredFromMe: amountSpentByAlicePeriod_3,
				sentByPeer: objPackageSignedByBob
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.closing).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(3)
		expect(dataPayload.initiated_by).to.be.equal(this.aliceAddress)
		expect(dataPayload[this.aliceAddress]).to.be.equal(amountSpentByAlicePeriod_3)
		expect(dataPayload[this.bobAddress]).to.be.equal(amountSpentByBobPeriod_3)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)
		expect(dataPayload.trigger_unit).to.be.equal(unit)

		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.equal(depositedByAlicePeriod_3)
		expect(vars['balanceB']).to.be.equal(depositedByBobPeriod_3)
		expect(vars['spentByA']).to.be.equal(amountSpentByAlicePeriod_3)
		expect(vars['spentByB']).to.be.equal(amountSpentByBobPeriod_3)
		
	}).timeout(15000)


	it('Bob confirms with wrong proof', async () => {

		const aliceMessage = { 
			amount_spent: amountSpentByAlicePeriod_3 - 1000, 
			period: 3,
			aa_address: this.aa_address 
		};

		const { signedPackage: objPackageSignedByAlice } = await this.network.wallet.alice.signMessage(aliceMessage, this.aliceAddress);

		const { unit, error } = await await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				sentByPeer: objPackageSignedByAlice,
				fraud_proof: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.equal("the peer didn't lie in his favor")
		expect(response.bounced).to.be.true

	}).timeout(15000)


	it('Bob confirms with proof', async () => {

		const aliceMessage = { 
			amount_spent: amountSpentByAlicePeriod_3 + 1000, 
			period: 3,
			aa_address: this.aa_address 
		};

		const { signedPackage: objPackageSignedByAlice } = await this.network.wallet.alice.signMessage(aliceMessage, this.aliceAddress);

		const { unit, error } = await await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.aa_address,
			amount: 10000,
			data: {
				sentByPeer: objPackageSignedByAlice,
				fraud_proof: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.closed).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(3)
		expect(dataPayload.fraud_proof).to.be.equal(1)

		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)

		const payments = Utils.getExternalPayments(unitObj)
		expect(payments).to.have.lengthOf(1)
		const paymentToBob = payments.find(m => m.address === this.bobAddress)

		expect(paymentToBob.amount).to.be.above(depositedByBobPeriod_3 + depositedByAlicePeriod_3)


		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.undefined
		expect(vars['balanceB']).to.be.undefined
		expect(vars['spentByA']).to.be.undefined
		expect(vars['spentByB']).to.be.undefined
		expect(vars['close_initiated_by']).to.be.undefined
		expect(vars['close_start_ts']).to.be.undefined
		
		
	}).timeout(15000)

	const depositedByAlicePeriod_4 = 2e9;
	it('Alice opens channel', async () => {
		const { unit, error } = await this.network.wallet.alice.sendBytes({
			toAddress: this.aa_address,
			amount: depositedByAlicePeriod_4,
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit })
		const dataPayload = unitObj.messages.find(m => m.app === 'data').payload

		expect(dataPayload.open).to.be.equal(1)
		expect(dataPayload.period).to.be.equal(4)
		expect(dataPayload[this.aliceAddress]).to.be.equal(depositedByAlicePeriod_4)
		expect(dataPayload[this.bobAddress]).to.be.equal(0)
		event_id +=1;
		expect(dataPayload.event_id).to.be.equal(event_id)
		expect(dataPayload.trigger_unit).to.be.equal(unit)

		const { vars } = await this.network.deployer.readAAStateVars(this.aa_address)
		expect(vars['balanceA']).to.be.equal(depositedByAlicePeriod_4)

	}).timeout(15000)


	after(async () => {
		await this.network.stop()
	})
})
