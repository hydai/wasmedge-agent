/** Toolchain discovery: cargo + wasmedge binaries and one-time template warm
 * build. Mirrors ensureKernelPython's role at PoC scale (DESIGN.md §2.2). */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { TEMPLATE_DIR } from "./workspace.ts";

export interface ToolchainInfo {
	cargoBin: string;
	wasmedgeBin: string;
	wasmedgeVersion: string;
}

function findOnPath(bin: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(dir, bin);
		if (dir && existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function resolveToolchain(): ToolchainInfo {
	const cargoBin =
		process.env.WASMEDGE_AGENT_CARGO ?? findOnPath("cargo") ?? join(homedir(), ".cargo", "bin", "cargo");
	if (!existsSync(cargoBin)) {
		throw new Error(`cargo not found (checked WASMEDGE_AGENT_CARGO, PATH, ~/.cargo/bin)`);
	}

	const wasmedgeBin =
		process.env.WASMEDGE_AGENT_WASMEDGE ?? findOnPath("wasmedge") ?? join(homedir(), ".wasmedge", "bin", "wasmedge");
	if (!existsSync(wasmedgeBin)) {
		throw new Error(
			`wasmedge not found; install it or set WASMEDGE_AGENT_WASMEDGE to the binary path`,
		);
	}

	const targets = execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf-8" });
	if (!targets.includes("wasm32-wasip1")) {
		throw new Error(`rust target wasm32-wasip1 missing; run: rustup target add wasm32-wasip1`);
	}

	const wasmedgeVersion = execFileSync(wasmedgeBin, ["--version"], { encoding: "utf-8" }).trim();
	return { cargoBin, wasmedgeBin, wasmedgeVersion };
}

/** Build the template once so cloned workspaces start with a warm target/.
 * The only step that may touch the network (first crates.io fetch). */
export function warmTemplate(cargoBin: string): void {
	execFileSync(cargoBin, ["build", "--release", "-p", "cell"], {
		cwd: TEMPLATE_DIR,
		stdio: "pipe",
	});
}
