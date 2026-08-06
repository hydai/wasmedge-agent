import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForChildProcess } from "../src/utils/child-process.js";

describe("waitForChildProcess", () => {
	it("reports signaled already-exited children as failures", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: null,
			stderr: null,
			exitCode: null,
			signalCode: "SIGTERM" as NodeJS.Signals,
		});

		await expect(waitForChildProcess(child as unknown as ChildProcess)).resolves.toBe(143);
	});
});
