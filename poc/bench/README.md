# PoC benchmark harness (DESIGN.md §6.2–6.3)

Measures the D20 GO/NO-GO question: can models work effectively in
cell-as-program mode (group B, `rust` + WasmEdge) versus the ipython baseline
(group A), at acceptable token cost?

## Layout

```
bench/
├── run.ts        # driver: (task × model × group × rep) headless runs
├── analyze.ts    # session JSONL → per-run CSV + per-condition aggregates + D20 gate
├── tasks/<id>/   # task.json (prompts/turns/timeout), fixture/, check.sh
└── results/      # gitignored: runs/<runId>/{project,agent-dir,workspaces,meta.json,turn-*.log}
```

## Tasks (full set, DESIGN.md appendix C)

| id | category | shape |
|---|---|---|
| 01-log-stats | text-data | count ERROR kinds in a 96-line log → report.md |
| 02-csv-normalize | text-data | messy CSV → typed users.json |
| 03-fix-bug | code-fix | planted `<` vs `<=` bug; project tests must pass |
| 04-multi-turn-state | state-reuse | turn 1 explore + persist; turn 2 answer from notes |
| 05-toolchain-loop | toolchain | two planted bugs; iterate `node --test` until green |
| 06-build-cli | build | write wordfreq.js CLI matching an exact output contract |
| 07-todo-scan | text-data | multi-file TODO/FIXME scan → todos.md, exact format |
| 08-rust-rename | code-fix | cross-file rename in a Rust crate; `cargo test` stays green |
| 09-helper-accumulation | state-reuse | 3 turns: build capability → reuse on 2nd log → combined summary |
| 10-lint-fix | toolchain | fix all `node lint.js` violations, behavior tests stay green |
| 11-join-report | build | join customers.json × orders.csv → spend.md |
| 12-repair-config | build | repair error-injected config.json against strict validator + OPS.md |

(Wave-1 measurement launched before 07–12 existed and covers 01–06; rerun with
`--tasks 07-...,...` or without `--tasks` for the full set.)

Every fixture is deterministic and every `check.sh` is offline (node + coreutils
only). Prompts are group-neutral ("the project root"): group A resolves it as
cwd, group B as /workspace.

## Running

```bash
# smoke: one task, treatment group only, 1 rep
node poc/bench/run.ts --tasks 01-log-stats --groups B --reps 1

# full wave-1, both groups, 3 reps, D17 prompt sub-A/B on group B
node poc/bench/run.ts --groups A,B --reps 3 --variant split \
  --models bytefuture/anthropic/claude-sonnet-4-6,bytefuture/anthropic/claude-opus-5

node poc/bench/analyze.ts
```

Requirements: `~/.prime/agent/models.json` configured (bytefuture gateway),
`TOKEN_STATION_TOKEN` in env, prime-agent runnable from source
(`BENCH_PRIME_AGENT` overrides the path), and for group B the PoC extension
prerequisites (see `../README.md`). Group A bootstraps a shared kernel venv on
first run (`~/.wasmedge-agent/bench/kernel-venv`, one-time).

Isolation per run: fresh fixture copy as the project dir, fresh
`PRIME_AGENT_CODING_AGENT_DIR` (so sessions/artifacts stay inside the run dir),
fresh group-B workspace root. Multi-turn tasks use `--resume` between turns.

## Metrics (analyze.ts)

Per run: pass (check.sh), wall time, tokens in/out (incl. cache), assistant
turns, tool calls by name, cell count, compile-error cell share, cell duration
p50/p95, error tool results. Aggregates are medians per (model, group[/variant])
with the D20 gate evaluated per model: B pass-rate ≥ A − 15pp and B median
output tokens ≤ 2.0 × A.

Known caveat: the bytefuture gateway does not report input tokens in streaming
responses, so `tokensIn` reads 0 through this provider. Both groups measure
through the same path, so the A/B comparison is unaffected; the D20 token gate
uses output tokens.
