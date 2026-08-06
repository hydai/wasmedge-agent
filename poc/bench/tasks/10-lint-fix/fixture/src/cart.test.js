"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { itemCount, isEmpty } = require("./cart.js");
const { label } = require("./label.js");

test("counts items", () => {
	assert.strictEqual(itemCount({ lines: [{ qty: 2 }, { qty: 0 }, { qty: 3 }] }), 5);
});
test("empty cart", () => {
	assert.strictEqual(isEmpty({ lines: [] }), true);
});
test("sale label", () => {
	assert.strictEqual(label({ name: "Mug", sale: true }), "SALE Mug");
	assert.strictEqual(label({ name: "Pen", sale: false }), "Pen");
});
