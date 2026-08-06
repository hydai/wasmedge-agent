"use strict";
function itemCount(cart) {
	var n = 0;
	for (const line of cart.lines) {
		if (line.qty != 0) {
			n += line.qty;
		}
	}
	return n;
}
function isEmpty(cart) {
	return itemCount(cart) == 0;
}
module.exports = { itemCount, isEmpty };
