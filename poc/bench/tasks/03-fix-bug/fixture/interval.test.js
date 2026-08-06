"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { mergeIntervals } = require("./interval.js");

test("merges overlapping", () => {
	assert.deepStrictEqual(mergeIntervals([[1, 4], [2, 6]]), [[1, 6]]);
});
test("touching intervals merge", () => {
	assert.deepStrictEqual(mergeIntervals([[1, 3], [3, 5]]), [[1, 5]]);
});
test("disjoint stay separate", () => {
	assert.deepStrictEqual(mergeIntervals([[7, 8], [1, 2]]), [[1, 2], [7, 8]]);
});
test("empty input", () => {
	assert.deepStrictEqual(mergeIntervals([]), []);
});
