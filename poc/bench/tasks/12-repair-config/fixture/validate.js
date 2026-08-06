"use strict";
// Strict config validator: exits 0 only when config.json is fully valid.
const fs = require("fs");
let raw;
try {
	raw = fs.readFileSync(__dirname + "/config.json", "utf8");
} catch (e) {
	console.error("cannot read config.json"); process.exit(1);
}
let cfg;
try {
	cfg = JSON.parse(raw);
} catch (e) {
	console.error("config.json is not valid JSON: " + e.message); process.exit(1);
}
const fail = (msg) => { console.error("invalid: " + msg); process.exit(1); };
if (cfg.host !== "api.internal") fail("host must be the string 'api.internal'");
if (typeof cfg.port !== "number" || cfg.port !== 8080) fail("port must be the number 8080");
if (!Number.isInteger(cfg.retries) || cfg.retries !== 3) fail("retries must be the integer 3 (ops policy, see OPS.md)");
if (typeof cfg.timeout_ms !== "number" || cfg.timeout_ms < 100) fail("timeout_ms must be a number >= 100");
if (!Array.isArray(cfg.features) || cfg.features.length !== 2 || !cfg.features.every((f) => typeof f === "string")) {
	fail("features must be an array of exactly 2 strings");
}
console.log("config valid");
