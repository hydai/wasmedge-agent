"use strict";
function handle(event) {
	return `push:${event.kind}`;
}
module.exports = { handle };
