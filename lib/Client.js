'use strict';

const $request = require('request');

const constants = require('./consts');
const Keys = require('./keymanagers/Keys');
const defaultKeyEncryptor = require('./keymanagers/defaultKeyEncryptor');

const signer = require('./middleware/signer');
const serializer = require('./middleware/serializer');
const response = require('./middleware/response');

const stringifyKeys = (keys) => {
	Object.keys(keys).map((key) => {
		keys[key] = keys[key] === null ? null : keys[key].toPem();

		return key;
	});

	return JSON.stringify(keys);
};

module.exports = class Client {
	constructor({
		url,
		partnerId,
		userId,
		hostId,
		passphrase,
		keyStorage,
		tracesStorage,
	}) {
		if (!url)
			throw new Error('EBICS URL is requierd');
		if (!partnerId)
			throw new Error('partnerId is requierd');
		if (!userId)
			throw new Error('userId is requierd');
		if (!hostId)
			throw new Error('hostId is requierd');
		if (!passphrase)
			throw new Error('passphrase is requierd');

		if (!keyStorage || typeof keyStorage.read !== 'function' || typeof keyStorage.write !== 'function')
			throw new Error('keyStorage implementation missing or wrong');

		this.url = url;
		this.partnerId = partnerId;
		this.userId = userId;
		this.hostId = hostId;
		this.keyStorage = keyStorage;
		this.keyEncryptor = defaultKeyEncryptor({ passphrase });
		this.tracesStorage = tracesStorage || null;
	}

	async send(order) {
		const isInObject = ('operation' in order);

		if (!isInObject) throw new Error('Operation for the order needed');

		if (order.operation.toUpperCase() === constants.orderOperations.ini) return this.initialization(order);

		const keys = await this.keys();
		if (keys === null) throw new Error('No keys provided. Can not send the order or any other order for that matter.');

		if (order.operation.toUpperCase() === constants.orderOperations.upload) return this.upload(order);
		if (order.operation.toUpperCase() === constants.orderOperations.download) return this.download(order);

		throw new Error('Wrong order operation provided');
	}

	async initialization(order) {
		const keys = await this.keys();
		if (keys === null) this._generateKeys();
        console.log("keys in initialization",keys);
		if (this.tracesStorage)
			this.tracesStorage.new().ofType('ORDER.INI');
		const res = await this.ebicsRequest(order);
		const xml = res.orderData();

		const returnedTechnicalCode = res.technicalCode();
		const returnedBusinessCode = res.businessCode();

		return {
			orderData: xml.length ? xml.toString() : xml,
			orderId: res.orderId(),

			technicalCode: returnedTechnicalCode,
			technicalCodeSymbol: res.technicalSymbol(),
			technicalCodeShortText: res.technicalShortText(returnedTechnicalCode),
			technicalCodeMeaning: res.technicalMeaning(returnedTechnicalCode),

			businessCode: returnedBusinessCode,
			businessCodeSymbol: res.businessSymbol(returnedBusinessCode),
			businessCodeShortText: res.businessShortText(returnedBusinessCode),
			businessCodeMeaning: res.businessMeaning(returnedBusinessCode),

			bankKeys: res.bankKeys(),
		};
	}

	async download(order) {
		if (this.tracesStorage)
			this.tracesStorage.new().ofType('ORDER.DOWNLOAD');
		const res = await this.ebicsRequest(order);

		order.transactionId = res.transactionId();

		if (res.isSegmented() && res.isLastSegment()) {
			if (this.tracesStorage)
				this.tracesStorage.connect().ofType('RECEIPT.ORDER.DOWNLOAD');

			await this.ebicsRequest(order);
		}

		const returnedTechnicalCode = res.technicalCode();
		const returnedBusinessCode = res.businessCode();

		return {
			orderData: res.orderData(),
			orderId: res.orderId(),

			technicalCode: returnedTechnicalCode,
			technicalCodeSymbol: res.technicalSymbol(),
			technicalCodeShortText: res.technicalShortText(returnedTechnicalCode),
			technicalCodeMeaning: res.technicalMeaning(returnedTechnicalCode),

			businessCode: returnedBusinessCode,
			businessCodeSymbol: res.businessSymbol(returnedBusinessCode),
			businessCodeShortText: res.businessShortText(returnedBusinessCode),
			businessCodeMeaning: res.businessMeaning(returnedBusinessCode),
		};
	}

	async upload(order) {
		if (this.tracesStorage)
			this.tracesStorage.new().ofType('ORDER.UPLOAD');
		let res = await this.ebicsRequest(order);
		const transactionId = res.transactionId();
		const orderId = res.orderId();

		order.transactionId = transactionId;

		if (this.tracesStorage)
			this.tracesStorage.connect().ofType('TRANSFER.ORDER.UPLOAD');
		res = await this.ebicsRequest(order);

		return [transactionId, orderId];
	}

	ebicsRequest(order) {
		return new Promise(async (resolve, reject) => {
			const { version } = order;
			const keys = await this.keys();
			console.log("order sent to ebics request",order)
			console.log("Keys in ebics request",keys);
			const r = signer.version(version).sign((await serializer.use(order, this)).toXML(), keys.x());
			Console.log("Request To Ebics",r,this.url);
			const send = () => $request.post({
				url: this.url,
				body: r,
				headers: { 'content-type': 'text/xml;charset=UTF-8' },
			}, (err, res, data) => {
				console.log("Response from Ebics: ", res);
				if (err) return reject(err);

				const ebicsResponse = response.version(version)(data, keys);

				if (this.tracesStorage)
					this.tracesStorage.label(`RESPONSE.${order.orderDetails.OrderType}`).connect().data(ebicsResponse.toXML()).persist();

				return resolve(ebicsResponse);
			});

			if (this.tracesStorage) {
				this.tracesStorage.label(`REQUEST.${order.orderDetails.OrderType}`).data(r).persist();
				return send();
			}
			return send();
		});
	}

	async keys() {
		try {
			const keysString = await this._readKeys();
			console.log("keyString in ebics cliet",keysString);

			return new Keys(JSON.parse(this.keyEncryptor.decrypt(keysString)));
		} catch (err) {
			return null;
		}
	}

	_generateKeys() {
		const keysObject = Keys.generate();
        console.log("In generate keys",keysObject);
		this._writeKeys(keysObject);
	}

	async setBankKeys(bankKeys) {
		const keysObject = await this.keys();

		keysObject.setBankKeys(bankKeys);
		await this._writeKeys(keysObject);
	}

	_readKeys() {
		return this.keyStorage.read();
	}

	_writeKeys(keysObject) {
		return this.keyStorage.write(this.keyEncryptor.encrypt(stringifyKeys(keysObject.keys)));
	}
};
