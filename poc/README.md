# wasmedge-agent PoC (Phase 0)

Rust-cell runtime for [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent),
mounted as an extension — no fork. See `../DESIGN.md` §6 for scope and the
benchmark protocol; `../REPORT.md` for the feasibility analysis.

The model gets one `rust` tool: each call is a complete Rust program compiled to
`wasm32-wasip1` and run in a WasmEdge sandbox. Persistence is explicit
(DESIGN.md D14): `rlm::state` key-value + blobs, a growable `agent_lib` crate
(declarative `lib` tool parameter), and files. `bash` stays available for the
project's own commands (D13).

## Prerequisites

- Rust toolchain with `rustup target add wasm32-wasip1`
- WasmEdge (`wasmedge` on PATH, `~/.wasmedge/bin`, or `WASMEDGE_AGENT_WASMEDGE=<path>`)
- prime-agent runnable from source (`npm install` in its repo) or the released binary
- Node >= 22 (the loop test uses native type stripping)

## Layout

```
poc/
├── extension/           # prime-agent extension (host side)
│   ├── index.ts         # rust + bash tools, prompt override, session lifecycle
│   └── runtime/         # standalone cell runtime (no prime-agent imports)
├── guest/template/      # cargo workspace template: agent_lib + cell + rlm
└── test/loop-test.ts    # 11 standalone checks, no LLM needed
```

## Run the loop test (no LLM, no prime-agent)

```bash
node poc/test/loop-test.ts
```

Expected: `ALL PASS`. First run warms the template (fetches crates once);
afterwards each cell is ~0.3–0.7s compile + ~15ms run.

## Run against prime-agent

```bash
cd /path/to/your/project
prime-agent --no-builtin-tools -e /path/to/wasmedge-agent/poc/extension
```

Env knobs:

| Var | Meaning |
|---|---|
| `WASMEDGE_AGENT_WASMEDGE` | wasmedge binary path override |
| `WASMEDGE_AGENT_CARGO` | cargo binary path override |
| `WASMEDGE_POC_PROMPT` | `example` (default) or `noexample` — D17 prompt sub-A/B |
| `WASMEDGE_POC_WORKSPACE` | named workspace, reused across runs (default: fresh per session) |
| `WASMEDGE_POC_WORKSPACE_ROOT` | workspace root (default `~/.wasmedge-agent/poc/workspaces`; keep it under HOME — readonly preopens fail under `/var/folders` on macOS) |

Workspaces persist under `~/.wasmedge-agent/poc/workspaces/` for inspection:
`state/state.json` is the agent's key-value state, `agent_lib/src/helpers/` its
self-written library.

## PoC scope cuts (by design)

No host bridge yet — `rlm::spawn` / `agent_message` / `goal` / MCP arrive with
Phase 1 (DESIGN.md §2.7). No custom TUI rendering; no skills; prelude is fixed
(D15). The benchmark harness (`bench/`, DESIGN.md §6.3) is the next M0 work item.
