/**
 * wasmedge-agent PoC extension (DESIGN.md §6).
 *
 * Registers a `rust` cell tool (WasmEdge-sandboxed, persistent workspace) and
 * re-registers the SDK `bash` tool, and replaces the system prompt with
 * RUST_CONTROL_PROMPT v0. Run against stock prime-agent:
 *
 *   prime-agent --no-builtin-tools -e /path/to/poc/extension
 *
 * Env knobs:
 *   WASMEDGE_AGENT_WASMEDGE   wasmedge binary (default: PATH, ~/.wasmedge/bin)
 *   WASMEDGE_AGENT_CARGO      cargo binary (default: PATH, ~/.cargo/bin)
 *   WASMEDGE_POC_PROMPT       "example" (default) | "noexample"  (D17 sub-A/B)
 *   WASMEDGE_POC_WORKSPACE    reuse a named workspace across runs
 *   WASMEDGE_POC_WORKSPACE_ROOT  override the HOME-based workspace root
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CellRunner, composeToolText } from "./runtime/cell-runner.ts";
import { buildSystemPrompt, type PromptVariant } from "./runtime/prompt.ts";
import { resolveToolchain, type ToolchainInfo, warmTemplate } from "./runtime/toolchain.ts";
import type { CellInput, CellResult } from "./runtime/types.ts";
import { createWorkspace, listPersistentState, TEMPLATE_DIR } from "./runtime/workspace.ts";

const CELL_TIMEOUT_MS = 120_000;

const rustParameters = Type.Object({
	code: Type.String({
		description:
			"A complete Rust program: `use agent_lib::prelude::*;` then `fn main() -> Result<()>`. " +
			"Compile errors are returned as feedback; fix and resubmit the full program.",
	}),
	lib: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.String({
					description: "File path inside agent_lib/, e.g. src/helpers/log_parse.rs",
				}),
				content: Type.String({ description: "Full file content (Rust source)" }),
			}),
			{
				description:
					"Optional: files to write into your persistent agent_lib crate before compiling. " +
					"Compiled together with the cell; if the library fails to build, the files are " +
					"reverted and the cell does not run.",
			},
		),
	),
});

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	let toolchain: ToolchainInfo | undefined;
	let runner: CellRunner | undefined;
	let workspaceDir: string | undefined;
	let startupError: string | undefined;

	function ensureRunner(): CellRunner {
		if (startupError) throw new Error(startupError);
		if (!toolchain || !workspaceDir) throw new Error("wasmedge-agent runtime is not initialized");
		if (!runner) {
			runner = new CellRunner({
				cwd,
				workspaceDir,
				wasmedgeBin: toolchain.wasmedgeBin,
				cargoBin: toolchain.cargoBin,
				cellTimeoutMs: CELL_TIMEOUT_MS,
			});
		}
		return runner;
	}

	pi.registerTool({
		name: "rust",
		label: "rust",
		description:
			"Execute a complete Rust program (a 'cell') compiled to wasm32-wasip1 and run in a " +
			"WasmEdge sandbox. Cells are not REPL fragments: variables do not persist between " +
			"cells. Persistent layers instead: rlm::state (key-value), the agent_lib crate " +
			"(extend it by passing lib files alongside your code), and files. Project imports, " +
			"tests, scripts, CLIs, and dependency checks must run through the project's own " +
			"environment via the bash tool.",
		parameters: rustParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			const input = params as CellInput;
			const result: CellResult = await ensureRunner().execute(input, {
				signal,
				onChunk: (chunk) => {
					onUpdate?.({ content: [{ type: "text", text: chunk }], details: { status: "running" } });
				},
			});
			const text = composeToolText(result);
			return {
				content: [{ type: "text", text: text || "(no output)" }],
				details: result,
				isError: result.status !== "ok",
			} as never;
		},
	});

	// Keep bash available under --no-builtin-tools (D13: dual built-ins).
	pi.registerTool(createBashTool(cwd));

	pi.on("before_agent_start", () => {
		const variant = (process.env.WASMEDGE_POC_PROMPT === "noexample" ? "noexample" : "example") as PromptVariant;
		return { systemPrompt: buildSystemPrompt({ cwd, variant }) };
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			toolchain = resolveToolchain();
			if (!existsSync(join(TEMPLATE_DIR, "target", "wasm32-wasip1", "release", "cell.wasm"))) {
				ctx.ui.notify("wasmedge-agent: warming template workspace (one-time)...", "info");
				warmTemplate(toolchain.cargoBin);
			}
			workspaceDir = createWorkspace(process.env.WASMEDGE_POC_WORKSPACE);
			runner = undefined;
			startupError = undefined;
			const state = listPersistentState(workspaceDir);
			const stateNote =
				state.stateKeys.length > 0 || state.libFunctions.length > 0
					? ` (state keys: ${state.stateKeys.length}, lib fns: ${state.libFunctions.length})`
					: "";
			ctx.ui.setStatus("wasmedge", ctx.ui.theme.fg("accent", `🦀 ${toolchain.wasmedgeVersion.split(" ")[1] ?? "wasmedge"}${stateNote}`));
		} catch (err) {
			startupError = `wasmedge-agent runtime unavailable: ${err instanceof Error ? err.message : err}`;
			ctx.ui.notify(startupError, "error");
		}
	});
}
