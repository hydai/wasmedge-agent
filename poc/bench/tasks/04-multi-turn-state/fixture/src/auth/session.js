"use strict";
function createSession(user) {
	return { user, at: 0 };
}
module.exports = { createSession };
