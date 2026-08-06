# wasmedge-agent

**A runtime-swap fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent): the model writes Rust instead of Python, and every cell runs sandboxed in [WasmEdge](https://github.com/WasmEdge/WasmEdge).**

Status: **incubation (Phase 1)**. The runtime surgery is in progress; during this
phase the binary, package names, env prefixes (`PRIME_AGENT_*`), and config
directory intentionally keep their upstream identities (see `DESIGN.md` D25) —
only this README carries the fork's identity.

## What changes, what stays

Prime Agent's design — one programmatic control-environment tool, recursive
`rlm(...)` subagents, the continual harness — stays. What this fork replaces is
the runtime under it:

| | upstream | this fork |
|---|---|---|
| Model-facing tool | `ipython` (persistent kernel) | `rust` (cell = complete program) |
| Execution | host Python, no sandbox | `wasm32-wasip1` in WasmEdge, capability-scoped preopens |
| Persistence | in-memory namespace + dill snapshots | explicit: `rlm::state` KV/blobs + growable `agent_lib` crate + files |
| Feedback loop | runtime tracebacks | rustc diagnostics (compile errors are first-class feedback) |

Design documents: `REPORT.md` (feasibility study), `DESIGN.md` (formalized
design, decisions D1–D25), `docs/m1-measurement-report.md` (Phase 0 GO
measurement: 146 runs, treatment passes 73/73 within the token gate),
`poc/` (the Phase 0 extension, guest workspace template, and benchmark harness).

## Attribution

This repository carries the full history of and is built on
[**Prime Agent**](https://github.com/PrimeIntellect-ai/prime-agent) by
[Prime Intellect](https://primeintellect.ai) (MIT), which in turn builds on
[**pi**](https://github.com/badlogic/pi-mono) by Mario Zechner and contributors
(MIT). We are grateful to both. Upstream's documentation lives on under
`packages/coding-agent/docs/`; the original upstream README is preserved in git
history.

## License

MIT — see `LICENSE`.
