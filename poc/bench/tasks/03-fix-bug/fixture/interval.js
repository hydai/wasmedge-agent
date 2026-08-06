"use strict";
// Merge overlapping [start, end] intervals. Input may be unsorted.
function mergeIntervals(intervals) {
	if (intervals.length === 0) return [];
	const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
	const out = [sorted[0].slice()];
	for (const [start, end] of sorted.slice(1)) {
		const last = out[out.length - 1];
		if (start < last[1]) {
			last[1] = Math.max(last[1], end);
		} else {
			out.push([start, end]);
		}
	}
	return out;
}
module.exports = { mergeIntervals };
