"use strict";
// Median of a numeric array (empty -> null).
function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort();
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Mode: most frequent value; ties -> smallest. (empty -> null)
function mode(values) {
	if (values.length === 0) return null;
	const counts = new Map();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	let best = values[0];
	for (const [v, n] of counts) {
		if (n > (counts.get(best) ?? 0)) best = v;
	}
	return best;
}
module.exports = { median, mode };
