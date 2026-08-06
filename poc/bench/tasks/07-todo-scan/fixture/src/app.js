"use strict";
const { formatRow } = require("./util.js");

function render(rows) {
	// TODO: cache rendered output
	return rows.map(formatRow).join("\n");
}

function main() {
	const rows = [{ id: 1 }, { id: 2 }];
	console.log(render(rows));
	// TODO: exit code handling
}

main();
