/** Shared types for the PoC cell runtime. No prime-agent imports here so the
 * runtime stays testable outside the extension host (DESIGN.md §6.1). */

export interface LibFile {
	/** Path inside agent_lib/, e.g. "src/helpers/log_parse.rs". */
	path: string;
	/** Full file content (Rust source). */
	content: string;
}

export interface CellInput {
	code: string;
	lib?: LibFile[];
}

export type CellStatus = "ok" | "compile_error" | "error" | "timeout" | "aborted";

export interface CellResult {
	status: CellStatus;
	stdout: string;
	stderr: string;
	compileDiagnostics?: string;
	exitCode?: number;
	durationMs: number;
	compileMs: number;
	runMs: number;
	libApplied: boolean;
	libReverted: boolean;
	/** True when the /agent/lib readonly bind had to fall back to read-write. */
	libReadonlyFallback: boolean;
}

export interface RunnerOptions {
	/** Project directory mounted at /workspace. */
	cwd: string;
	/** Session workspace directory (cargo workspace lives here). */
	workspaceDir: string;
	/** wasmedge binary path. */
	wasmedgeBin: string;
	/** cargo binary path. */
	cargoBin: string;
	/** Total per-cell budget in ms (compile + run). */
	cellTimeoutMs: number;
}

export interface PerCallOptions {
	/** Streaming callback for live stdout/stderr chunks. */
	onChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
	/** Abort signal (user interrupt). */
	signal?: AbortSignal;
}

export const MAX_OUTPUT_CHARS = 65_536;

export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[... output truncated at ${limit} chars ...]`;
}
