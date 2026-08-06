"use strict";
function handle(req) {
	return { ok: true, user: req.user };
}
function validate(req) {
	return typeof req.user === "string";
}
module.exports = { handle, validate };
