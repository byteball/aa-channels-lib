/*jslint node: true */
"use strict";
var constants = require('ocore/constants.js');
var objectHash = require('ocore/object_hash.js');
var ecdsaSig = require('ocore/signature.js');
var _ = require('lodash');
var ValidationUtils = require("ocore/validation_utils.js");


function validateSignedMessage(objSignedMessage, handleResult) {
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

	if (authors.length > 1)
		return handleResult("co signers not supported");

	var objAuthor = authors[0];

	if (ValidationUtils.hasFieldsExcept(objAuthor, ['address', 'definition', 'authentifiers']))
		return handleResult("foreign fields in author");
	else if (!ValidationUtils.isValidAddress(objAuthor.address))
		return handleResult("not valid address");
	if (!ValidationUtils.isNonemptyObject(objAuthor.authentifiers))
		return handleResult("no authentifiers");

	function validateDefinition(cb) {
		var bHasDefinition = ("definition" in objAuthor);

		if (!bHasDefinition)
			return handleResult("no definition");

		const definition = objAuthor.definition;
		if (!Array.isArray(definition))
			return handleResult("unsupported definition");

		if (definition[0] != 'sig')
			return handleResult("unsupported definition");

		if (typeof definition[1] != 'object')
			return handleResult("unsupported definition");

		try {
			if (objectHash.getChash160(definition) !== objAuthor.address)
				return handleResult("wrong definition: " + objectHash.getChash160(definition) + "!==" + objAuthor.address);
		} catch (e) {
			return handleResult("failed to calc address definition hash: " + e);
		}
		cb(definition);
	}

	validateDefinition(function (definition) {
		try {
			var unit_hash_to_sign = objectHash.getSignedPackageHashToSign(objSignedMessage)
		}
		catch (e) {
			return handleResult("failed to calc unit_hash_to_sign: " + e);
		}
		// passing db as null
		validateAuthentifiers(definition, unit_hash_to_sign, objAuthor.authentifiers,
			function (err, res) {
				if (err) // error in address definition
					return handleResult(err);
				if (!res) // wrong signature or the like
					return handleResult("authentifier verification failed");
				handleResult(null);
			}
		);
	});
}


function validateAuthentifiers(definition, unit_hash_to_sign, assocAuthentifiers, cb){
	var signature = assocAuthentifiers['r'];
	if (!signature)
		return cb("No signature at path r");
	var res = ecdsaSig.verify(unit_hash_to_sign, signature, definition[1].pubkey);
	if (!res)
		return cb("error when checking signature at path r");
	cb(null, res);
	
}

exports.validateSignedMessage = validateSignedMessage;
