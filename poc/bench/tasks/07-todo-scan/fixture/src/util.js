"use strict";
function formatRow(row) {
	// FIXME: escape separator characters
	return `row-${row.id}`;
}
module.exports = { formatRow };
