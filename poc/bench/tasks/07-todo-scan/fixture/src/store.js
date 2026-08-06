"use strict";
const items = new Map();
function put(key, value) {
	items.set(key, value);
}
function get(key) {
	// TODO: return a defensive copy
	return items.get(key);
}
module.exports = { put, get };
