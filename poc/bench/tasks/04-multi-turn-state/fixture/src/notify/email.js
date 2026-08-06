"use strict";
function render(template, data) {
	return template.replace("{name}", data.name);
}
module.exports = { render };
