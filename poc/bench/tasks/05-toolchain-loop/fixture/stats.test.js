"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { median, mode } = require("./stats.js");

test("median sorts numerically, not lexicographically", () => {
	assert.strictEqual(median([10, 9, 100]), 10);
});
test("median of even-length array", () => {
	assert.strictEqual(median([4, 1, 3, 2]), 2.5);
});
test("mode picks most frequent", () => {
	assert.strictEqual(mode([2, 3, 3, 2, 3]), 3);
});
test("mode tie picks smallest value", () => {
	assert.strictEqual(mode([5, 1, 5, 1]), 1);
});
test("empty arrays", () => {
	assert.strictEqual(median([]), null);
	assert.strictEqual(mode([]), null);
});
