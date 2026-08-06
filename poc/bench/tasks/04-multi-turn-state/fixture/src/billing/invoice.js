"use strict";
function totalOf(items) {
	return items.reduce((s, i) => s + i.amount, 0);
}
function format(invoice) {
	return `#${invoice.id}: ${totalOf(invoice.items)}`;
}
module.exports = { totalOf, format };
