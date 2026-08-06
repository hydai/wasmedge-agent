"use strict";
function label(product) {
	var prefix = product.sale == true ? "SALE " : "";
	return prefix + product.name;
}
module.exports = { label };