/*jslint node: true */
"use strict";
var constants = require('ocore/constants.js');
var objectHash = require('ocore/object_hash.js');
var ecdsaSig = require('ocore/signature.js');
var _ = require('lodash');
var ValidationUtils = require("ocore/validation_utils.js");


function validateSignedMessage(objSignedMessage, address, handleResult) {
	if (typeof objSignedMessage !== 'object')
		return handleResult("not an object");
	if (ValidationUtils.hasFieldsExcept(objSignedMessage, ["signed_message", "authors", "last_ball_unit", "timestamp", "version"]))
		return handleResult("unknown fields");
	if (!('signed_message' in objSignedMessage))
		return handleResult("no signed message");
	if ("version" in objSignedMessage && constants.supported_versions.indexOf(objSignedMessage.version) === -1)
		return handleResult("unsupported version: " + objSignedMessage.version);
	var authors = objSignedMessage.authors;
	if (!ValidationUtils.isNonemptyArray(authors))
		return handleResult("no authors");
	if (!address && !ValidationUtils.isArrayOfLength(authors, 1))
		return handleResult("authors not an array of len 1");
	var the_author;
	for (var i = 0; i < authors.length; i++){
		var author = authors[i];
		if (ValidationUtils.hasFieldsExcept(author, ['address', 'definition', 'authentifiers']))
			return handleResult("foreign fields in author");
		if (author.address === address)
			the_author = author;
		else if (!ValidationUtils.isValidAddress(author.address))
			return handleResult("not valid address");
		if (!ValidationUtils.isNonemptyObject(author.authentifiers))
			return handleResult("no authentifiers");
	}
	if (!the_author) {
		if (address)
			return cb("not signed by the expected address");
		the_author = authors[0];
	}
	var objAuthor = the_author;

	
	function validateOrReadDefinition(cb) {
		var bHasDefinition = ("definition" in objAuthor);

			if (!bHasDefinition)
				return handleResult("no definition");
			try {
				if (objectHash.getChash160(objAuthor.definition) !== objAuthor.address)
					return handleResult("wrong definition: " + objectHash.getChash160(objAuthor.definition) + "!==" + objAuthor.address);
			} catch (e) {
				return handleResult("failed to calc address definition hash: " + e);
			}
			cb(objAuthor.definition, -1, 0);
		}

	validateOrReadDefinition(function (arrAddressDefinition, last_ball_mci, last_ball_timestamp) {
		var objUnit = _.clone(objSignedMessage);
		objUnit.messages = []; // some ops need it
		try {
			var objValidationState = {
				unit_hash_to_sign: objectHash.getSignedPackageHashToSign(objSignedMessage),
				last_ball_mci: last_ball_mci,
				last_ball_timestamp: last_ball_timestamp,
				bNoReferences: !bNetworkAware
			};
		}
		catch (e) {
			return handleResult("failed to calc unit_hash_to_sign: " + e);
		}
		// passing db as null
		validateAuthentifiers(objValidationState, objAuthor.authentifiers,
			function (err, res) {
				if (err) // error in address definition
					return handleResult(err);
				if (!res) // wrong signature or the like
					return handleResult("authentifier verification failed");
				handleResult(null, last_ball_mci);
			}
		);
	});
}


function validateAuthentifiers(objValidationState, assocAuthentifiers, cb){
		var op = arr[0];
		var args = arr[1];
		if (op != 'sig')
			return cb("unsupported definition");
				var signature = assocAuthentifiers['r'];
				if (!signature)
					return cb("No signature at path r");
				arrUsedPaths.push(path);
				var algo = args.algo || 'secp256k1';
				if (algo === 'secp256k1'){
					var res = ecdsaSig.verify(objValidationState.unit_hash_to_sign, signature, args.pubkey);
					if (!res)
						return cb("error when checking signature at path r");
					cb(null, res);
				}
	}

exports.validateSignedMessage = validateSignedMessage;
