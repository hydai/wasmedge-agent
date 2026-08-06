"use strict";
// Project lint: exits 1 listing violations, 0 when clean.
// Rules: L001 no `var` declarations; L002 no `==`/`!=` (use ===/!==);
//        L003 file must end with exactly one trailing newline.
const fs = require("fs");
const path = require("path");
const violations = [];
const dir = path.join(__dirname, "src");
for (const name of fs.readdirSync(dir).sort()) {
	if (!name.endsWith(".js")) continue;
	const file = path.join(dir, name);
	const text = fs.readFileSync(file, "utf8");
	const lines = text.split("\n");
	lines.forEach((line, i) => {
		if (/\bvar\s+[A-Za-z_$]/.test(line)) violations.push(`src/${name}:${i + 1} L001 use let/const instead of var`);
		if (/[^=!<>]==[^=]/.test(line) || /!=[^=]/.test(line)) violations.push(`src/${name}:${i + 1} L002 use ===/!== instead of ==/!=`);
	});
	if (!text.endsWith("\n") || text.endsWith("\n\n")) violations.push(`src/${name}:${lines.length} L003 file must end with exactly one newline`);
}
if (violations.length > 0) {
	console.error(violations.join("\n"));
	process.exit(1);
}
console.log("lint clean");
