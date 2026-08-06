# wasmedge-agent 設計方案

**文件定位**：本文件承接《REPORT.md》（2026-08-06 可行性研究）的結論，依其建議路線——**Phase 0 以 extension 掛載 PoC（不 fork）→ Phase 1 fork prime-agent 置換 runtime 層 → Phase 2 功能對齊與 T2 runner**——給出可直接開工的完整工程設計。分析性內容（耦合面、實測數據、路線比較）不在此重複，見 REPORT.md 對應章節。

- 基準上游：`PrimeIntellect-ai/prime-agent` v0.7.0（HEAD `c22549a3`）
- 工作名稱：**wasmedge-agent**（模型可見工具名：`rust`）
- 目標平台：macOS / Linux（Windows 列 Phase 2 評估）
- 撰寫日期：2026-08-06
- **狀態：已定稿**——同日完成六輪逐節審閱，23 項決策（D1–D23）全數定案；審閱軌跡見 §11

---

## 目錄

1. [總體架構](#1-總體架構)
2. [核心元件設計](#2-核心元件設計)
3. [Prompt 設計（RUST_CONTROL_PROMPT 草案全文）](#3-prompt-設計)
4. [Skills 與自我改進](#4-skills-與自我改進)
5. [遞迴 subagent 與長任務功能](#5-遞迴-subagent-與長任務功能)
6. [Phase 0：PoC 詳細設計](#6-phase-0poc-詳細設計)
7. [Phase 1：Fork 手術計畫](#7-phase-1fork-手術計畫)
8. [Phase 2：概要設計](#8-phase-2概要設計)
9. [測試與驗證策略](#9-測試與驗證策略)
10. [組態與部署](#10-組態與部署)
11. [決策記錄（D1–D10）](#11-決策記錄)
12. [里程碑與時程](#12-里程碑與時程)
13. [附錄：協議範例與模板全文](#13-附錄)

---

## 1. 總體架構

### 1.1 系統圖（Phase 1 完成形態）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 沿用自 prime-agent（不動）                                            │
│  TUI / Print / JSON / RPC / ACP clients                              │
│  Daemon supervisor ── Session worker（一棵 session tree 一進程）      │
│    └ AgentSession                                                    │
│        ├ providers（packages/ai：9 API × 32 providers）              │
│        ├ session JSONL 樹 / lease / compaction / goals / autonomous  │
│        ├ HostRequestHandlers registry（rlm.run、goal.*、msg.*、mcp.*）│
│        └ tools registry ──┬── "rust"（新）                           │
│                           └── "bash"（啟用既有 tools/bash.ts）        │
├──────────────────────────────────────────────────────────────────────┤
│ 新增：core/rust-cell/（取代 core/kernel/ 3.3K 行）                    │
│                                                                      │
│  RustCellManager                                                     │
│    ├ WorkspaceManager     session cargo workspace 的建立/守護/git 化  │
│    ├ CompilePipeline      cargo build（offline、診斷解析、暖快取）     │
│    ├ ExecPipeline         wasmedge 子進程（preopen、env、串流、逾時）  │
│    └ BridgeServer         loopback TCP + JSON-lines（host bridge）    │
│         └→ 分派到既有 HostRequestHandlers（原封重用）                  │
├──────────────────────────────────────────────────────────────────────┤
│ Guest（Wasm 沙箱內，wasm32-wasip1）                                   │
│                                                                      │
│  cell.wasm（每回合重編譯的完整程式）                                   │
│    ├ use agent_lib::prelude::*   ← 持久函式庫（skills + 自建 helpers）│
│    └ rlm crate                   ← guest shim（≈prime-agent-runtime） │
│         ├ rlm::state             /agent/state serde KV               │
│         ├ rlm::spawn / msg / goal / display / harness / mcp          │
│         └ bridge client（wasi socket → BridgeServer）                 │
│                                                                      │
│  Preopens：/workspace（專案）、/agent（lib+state）、/scratch          │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 進程模型與生命週期

| 進程 | 生命週期 | 對應現制 |
|---|---|---|
| Session worker（TS） | 同現制（daemon 管理） | 不變 |
| `cargo build` | 每 cell 一次，短命 | —（新） |
| `wasmedge` | 每 cell 一次，短命（**無長命 kernel 進程**） | 取代長命 `ipykernel` |
| BridgeServer（TS，worker 內 listener） | session 首次用 `rust` 工具時 lazy 啟動，session 結束關閉 | 取代 ZMQ 三通道 |

關鍵差異：現制的「持久性」載體是 kernel 進程的記憶體；新制的持久性載體是**磁碟上的 workspace**（git 版本化）。因此 worker 崩潰/重啟後毫無狀態損失——不需要 forkserver、不需要 dill、不需要 busy-kernel interrupt 流程（cell 短命，逾時直接 kill）。

**已確認取捨（D11）**：無長命進程意味著 cell 之間不能在記憶體保留大型資料結構，每個 cell 對大輸入需重讀重解析。正式接受此語意；緩解模式為「解析一次、以 `rlm::state`/blobs（bincode 等序列化）存中間形式、後續 cell 載入預處理結果」。若 PoC/實運行顯示為真瓶頸，再評估 resident data service（不預先設計）。

### 1.3 設計原則

1. **Host 權威不變**：credentials、provider 呼叫、child 生命週期、transcript、政策全在 TS host；guest 只有 thin shim（與現制同構，見 REPORT §1.2）。
2. **程式碼即記憶**：跨回合資產只有三種形態——`agent_lib` 原始碼、`/agent/state` 資料、`/workspace` 專案檔案。全部可 diff、可版本化、可重放。
3. **誠實的沙箱邊界**：wasm 沙箱涵蓋 agent 自身計算；`bash` 與 host bridge 是有名有姓的顯式越權通道（REPORT §3.5 邊界圖）。文件與 README 不得宣稱「全沙箱」。
4. **決定性優先**：所有 side effect 過可記錄邊界（preopen FS + bridge），為 Phase 3 的 trajectory replay 留基礎；因此 guest 不直接持有網路能力（T1 的 socket 只准連 bridge，見 §2.7）。
5. **對上游的最小侵入**：改動集中在整塊替換目錄；散改點維護於 `SYNC.md` 清單（§7.3）。

---

## 2. 核心元件設計

### 2.1 Session Workspace

每個 persisted session 在 artifacts 目錄下有一個 host 管理的 cargo workspace（對映現制 `kernel-state.dill` 的位置語意）：

```
<session-artifacts>/<session-id>/workspace/
├── .git/                    # host 管理的版本化（見下）
├── Cargo.toml               # [workspace] members = ["agent_lib", "cell"]
├── .cargo/config.toml       # target=wasm32-wasip1、vendored registry、offline
├── agent_lib/
│   ├── Cargo.toml           # deps = 固定 prelude 集（serde、serde_json、regex、anyhow、…）+ rlm
│   └── src/
│       ├── lib.rs           # pub mod prelude; pub mod skills; pub mod helpers;
│       ├── prelude.rs       # re-exports + 常用 helpers（read_lines/grep/walk/edit_exact/…）
│       ├── skills/          # skills-as-crates 的 re-export 掛載點（§4.1）
│       └── helpers/         # ★ 模型自建函式的家（可自由新增檔案）
├── cell/
│   ├── Cargo.toml           # deps = agent_lib（間接取得全部 prelude）
│   └── src/main.rs          # ★ 每回合由 host 用工具參數覆寫
├── rlm/                     # guest shim crate（模板攜帶；host 於升級時覆寫，
│                            #  模型不應修改——scaffold 版本 marker 涵蓋其 hash）
├── state/                   # ★ guest 掛載為 /agent/state
│   ├── state.json           # rlm::state 的 KV 檔
│   └── blobs/               # 大物件（rlm::state::put_blob）
└── target/                  # 增量編譯快取（不進 git）
```

**Scaffold 流程**（`WorkspaceManager.ensure()`，對映 `ensureKernelPython`）：

1. 若 workspace 不存在：從安裝時預建的**模板**複製（macOS `clonefile` / Linux reflink，毫秒級），模板含已編譯好的 prelude 依賴 target 快取 → **消除 4.8s 冷啟動**（REPORT §2.4），首 cell 即 0.3s 級。
2. `git init` + 初始 commit（`.gitignore`: `target/`）。
3. 版本 marker `.workspace-version`（對映 `.bootstrap-version` schema 8 的機制）：記錄模板版本、prelude crate 集 hash、rustc/wasmedge 版本；不符時重建 scaffold 但**保留 `agent_lib/src/helpers`、`skills` 掛載與 `state/`**（使用者資產不可因升級消失——優於現制 venv 整個 rm -rf 的做法）。

**Lib 變更與防磚（D14 定案：宣告式）**：`/agent/lib` 對 guest 是**唯讀** preopen；模型擴充函式庫的唯一路徑是工具呼叫的選配 `lib` 參數（§2.5）。host 在編譯前寫入宣告的檔案，lib 與 cell **同次編譯**——lib 編不過 → 檔案回滾、cell 不執行、診斷即 tool result。推論：**每個成功執行過 cell 的 workspace 必然處於可編譯狀態**，不存在「事後偵測＋補救回滾」路徑。

- 每次 cell 成功執行後，host `git add -A && git commit`（訊息含 cell 序號與 tool call id）——replay 的資料基礎。
- `lib` 路徑驗證：僅接受 `src/**`（相對 `agent_lib/`）、拒絕 `..` 與絕對路徑；`Cargo.toml` 不可經此改動（依賴政策走 D15）。
- 非 persisted session（`--no-session`）：workspace 放 OS temp、不 git；lib 回滾改用編譯前記憶體備份。

### 2.2 RustCellManager（TS API）

取代 `KernelManager`，但介面刻意模仿其形狀以縮小 `AgentSession` 的改動面（對映 REPORT §1.12 的 85 處耦合點中多數只需改型別名）：

```ts
// core/rust-cell/index.ts
export interface RustCellManagerOptions {
  cwd: string;                          // 專案目錄（/workspace 掛載源）
  workspaceDir?: string;                // session workspace；undefined = temp（--no-session）
  env?: Record<string, string>;         // RLM_DEPTH 等（沿用 _rlmKernelEnv 的鍵）
  hostHandlers?: HostRequestHandlers;   // ★ 原封重用現有 registry 型別
  rustSkills?: RustSkillRuntimeInfo[];  // §4.1
  settings?: RustCellSettings;          // timeout、writePolicy、preludeExtra…
  onEmit?: (e: CellEmitEvent) => void;  // diff / attachment / agent-message（§2.9）
}

export class RustCellManager {
  static async ensureToolchain(onProgress?): Promise<ToolchainInfo>;
                                        // 對映 ensureKernelPython：檢查 rustup target
                                        // + wasmedge 可執行檔 + 模板 workspace
  async start(): Promise<void>;         // scaffold workspace + 啟動 BridgeServer（lazy）
  async execute(cell: CellInput, opts: ExecuteOptions): Promise<CellResult>;
                                        // 串行化（promise chain，同現制 executionQueue）
  async listPersistentState(): Promise<PersistentStateListing>;
                                        // state keys + agent_lib pub API（compaction 通知用）
  async interrupt(): Promise<void>;     // kill 當前 cell 子進程（cargo 或 wasmedge）
  async dispose(): Promise<void>;       // 關 BridgeServer；git commit 收尾
}

export interface CellInput {
  code: string;                         // cell/src/main.rs 內容
  lib?: { path: string; content: string }[];
                                        // 編譯前寫入 agent_lib/（D14；路徑限 src/**）
}

export interface CellResult {
  status: "ok" | "compile_error" | "error" | "timeout" | "aborted";
  stdout: string; stderr: string;       // 各截斷 65_536 字元（沿用 DEFAULT_MAX_OUTPUT_CHARS）
  compileDiagnostics?: string;          // rustc rendered 診斷（截斷 65_536）
  exitCode?: number;
  durationMs: number; compileMs: number; runMs: number;
  libApplied: boolean;                  // lib 參數已寫入且編譯通過（隨 cell 成功而 commit）
  libReverted?: boolean;                // compile_error 且宣告了 lib → 檔案已回滾
  diffs: KernelDiffDisplay[];           // 沿用現有型別；host 對 applied lib 檔自動合成 diff
  attachments: KernelAttachment[];      // 沿用（含 10MB 上限）
  sentAgentMessages: KernelSentAgentMessage[];
}
```

執行狀態機：`idle → compiling → running → committing → idle`；`interrupt()` 在 compiling/running 態 kill 對應子進程（process group SIGKILL，參照 sandbox 範例 `detached: true` 模式）。**無 busy-reuse 流程**——cell 短命，這整類複雜度（`KernelBusyAfterInterruptError`、restart notice、5 秒等待）刪除。

併發治理：cargo build 吃 CPU。沿用 `boot-gate.ts` 的許可證模式做 **compile gate**：全 worker 進程內同時編譯數 `min(4, cpus/2)`，可用 `WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS` 覆寫（對映 `PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS`）。

### 2.3 編譯管線

```
cargo build --release --target wasm32-wasip1 \
      --offline --message-format=json-diagnostic-rendered-ansi \
      -p cell
```

- **offline + vendored**：安裝時 `cargo vendor` 把 prelude 依賴鎖進 `~/.wasmedge-agent/vendor/`（全域共享、唯讀）；workspace 的 `.cargo/config.toml` 指向它。cell 編譯**永不碰網路**（供應鏈與決定性雙重理由）。
- **依賴政策（D15 定案）**：Phase 1 prelude 集**鎖死**；使用者可經 settings `preludeExtra` 追加（session 啟動時 host 重新 vendor）。`rlm::deps::add` 在 Phase 1 回明確的 not-supported 錯誤（指示改請使用者調 settings）；動態新增延至 Phase 2 以 curated 白名單實作（host 抓取 → re-vendor → 改 Cargo.toml → commit）。
- **診斷處理**：解析 message-format JSON 流，取 `rendered` 欄位串接（strip ANSI 後截斷 65,536）。編譯失敗 → `status: "compile_error"`、`isError: true`、**不執行**；診斷全文就是 tool result（REPORT §2.2 的一等回饋原則）。
- **profile**：release（0.28s 實測基準即 release）。`[profile.release] debug = false, incremental = true`；`codegen-units` 預設。不做 wasm-opt/strip（cell 短命，體積無關緊要）。
- 快取：per-session `target/`（模板預熱）。不跨 session 共享 target（鎖競爭與污染風險 > 收益；模板複製已解決冷啟動）。

### 2.4 執行管線

```
wasmedge \
  --dir /workspace:<cwd><:ro 若 writePolicy=ro> \
  --dir /agent/lib:<workspace>/agent_lib:ro \
  --dir /agent/state:<workspace>/state \
  --dir /scratch:<session-temp> \
  --env RLM_BRIDGE_PORT=<port> --env RLM_BRIDGE_TOKEN=<token> \
  --env RLM_DEPTH=<n> --env RLM_SESSION_DIR=/agent \
  <workspace>/target/wasm32-wasip1/release/cell.wasm
```

- `/agent/lib` 與 `/agent/state` 為**兩個獨立 preopen**（定案：不做合成 `/agent` 掛載，避免依賴 preopen 對 symlink 的行為；guest 路徑穩定為 `/agent/lib/src/...`、`/agent/state/...`）。`/agent/lib` 唯讀（D14——lib 變更只經 `lib` 參數）。
- **stdout/stderr 串流**：pipe 逐 chunk 經 `onUpdate` 送 TUI（沿用 `tool_execution_update` 事件路徑，REPORT §1 agent 探索確認該路徑 runtime 無關）；host 累積並截斷。
- **逾時**：單一 cell 總預算 `cellTimeoutMs`（預設 120,000；compile 與 run 共享）。逾時/使用者 abort → process group SIGKILL → `status: "timeout" | "aborted"`。
- 執行後守護（§2.1）：lib guard → git commit。
- 退出碼語意：`0` = ok；非 0（含 panic）= `status: "error"`，stderr 為主要回饋。

### 2.5 `rust` 工具定義

對映 `createIpythonToolDefinition`（保持單參數、sequential 的形狀）：

```ts
name: "rust",
label: "rust",
executionMode: "sequential",
description:
  "Execute a complete Rust program (a 'cell') compiled to wasm32-wasip1 and run in a " +
  "WasmEdge sandbox. Cells are not REPL fragments: variables do not persist between cells. " +
  "Persistent layers instead: rlm::state (key-value), the agent_lib crate (extend it by " +
  "passing lib files alongside your code), and files. Project imports, tests, scripts, CLIs, " +
  "and dependency checks must run through the project's own environment via the bash tool.",
parameters: Type.Object({
  code: Type.String({
    description:
      "A complete Rust program: `use agent_lib::prelude::*;` then `fn main() -> Result<()>`. " +
      "Compile errors are returned as feedback; fix and resubmit the full program.",
  }),
  lib: Type.Optional(Type.Array(Type.Object({
    path: Type.String({ description: "File path inside agent_lib/, e.g. src/helpers/log_parse.rs" }),
    content: Type.String({ description: "Full file content (Rust source)" }),
  }), {
    description:
      "Optional: files to write into your persistent agent_lib crate before compiling. " +
      "Compiled together with the cell; if the library fails to build, the files are " +
      "reverted and the cell does not run.",
  })),
}),
```

**Tool result 組裝規格**（對映 ipython.ts:667-696 的串接順序）：

```
[compile_error 時]  compileDiagnostics
                    ＋若宣告了 lib："\n[your lib files were reverted; the cell did not run]"
[執行後]            stdout ⧺ stderr
[exitCode ≠ 0 時]   "\n[cell exited with code {n}]"
content = [{type:"text", text}, ...imageBlocks]     // attachment → image block，沿用 mime.ts 白名單
isError = status !== "ok"
details  = CellResult                                // 供 renderer / ACP（§7 WP4）
```

Lib 檔套用成功時，host 對每個 lib 檔自動合成 `KernelDiffDisplay`（前值 vs 新值）進 `details.diffs`——使用者在 TUI 看到函式庫演化，零 guest 端成本。

### 2.6 Guest `rlm` crate

對映 `prime-agent-runtime`（Python 1,205 行 → 估 Rust 1–2K 行）。**全同步 API**（wasip1 無原生 async；bridge 呼叫延遲為 loopback RTT + handler 時間，且 `spawn` 語意本就 admission-only 立即返回——REPORT §2.2 第 10 項）。

```rust
// 模組佈局
rlm::error       // pub struct Error { kind: Bridge|Host|State|Io, message } + Result<T>
rlm::bridge      // (內部) TCP client、JSON-lines framing、token、重連
rlm::state       // get<T: DeserializeOwned>(key) -> Result<Option<T>>
                 // set<T: Serialize>(key, &T) / remove(key) / keys() -> Vec<String>
                 // put_blob(name, &[u8]) / get_blob(name)      → /agent/state（原子寫：tmp+rename）
rlm              // spawn(prompt) -> Result<SpawnHandle>
                 // spawn_named(prompt, name) / spawn_with(prompt, SpawnOpts{name, model})
                 // find_models(query, limit) -> Result<Vec<Model>>
                 // list_subagents() / delete_subagent(selector)
                 // host_request(type: &str, payload: serde_json::Value) -> Result<Value>  // 泛用門
rlm::msg         // send_to_parent(text) / send_to_child(name, text) / send_to_sibling(...)
                 // list_agents() -> Result<Vec<AgentInfo>>
rlm::goal        // get() / create(objective, GoalOpts) / complete()
rlm::compact     // status() / run(instructions)
rlm::refine      // status() / run(instructions, global)
rlm::heartbeat   // create / list / update / delete
rlm::observe     // list_agents / get_agent / recent_messages
rlm::display     // diff(path, old, new) / attach_image(path)   → emit 事件（§2.9）
rlm::harness     // 直讀寫 /agent/state/../harness/harness_state.json，沿用 schema v1
                 // （含 mtime 偵測重載——harness.py 的 _sync_from_disk 移植）
rlm::mcp         // list_tools(server) / call_tool(server, tool, json)
rlm::deps        // add(crate_name) -> Result<()>  // Phase 1 一律回 not-supported（D15）
rlm::prelude     // pub use 上述常用項 + anyhow::{Result, Context, bail}
```

`SpawnHandle { rlm_child_id, name, session_dir, model }`——欄位名與現制 payload 完全一致（`rlm-runtime.ts` 的驗證邏輯零修改）。

### 2.7 Host Bridge 協議規格 v1（T1）

**傳輸**：BridgeServer 在 `127.0.0.1:<ephemeral>` listen；port/token 經 `--env` 傳入 guest；guest 用 `wasmedge_wasi_socket` 建 TCP 連線（每 cell 一條持久連線，cell 結束即斷）。**Deny-by-default 網路的實現方式**：cell 的 wasm 不 link 任何其他網路能力，`rlm` crate 只連 bridge（guest 是我們發的 crate + 模型寫的 safe Rust，經由 crate API 才能碰 socket）；T2 換 host functions 後升級為運行時強制（§8.1、風險見 §11 D9）。

**Framing**：newline-delimited JSON（UTF-8，一行一訊息；換行以 `\n`，訊息內字串已由 JSON 轉義）。

```jsonc
// 1. 握手（guest → host，連線後第一則）
{"v": 1, "kind": "hello", "token": "<64-hex>", "cell": "<tool-call-id>"}
// host 回 {"v":1,"kind":"hello_ok"} 或關閉連線

// 2. Host request（guest → host；id 由 guest 遞增）
{"v":1, "kind":"req", "id": 3, "type": "rlm.run",
 "payload": {"prompt": "review the API", "kwargs": {"name": "api-reviewer"}}}
// host 回覆（順序不保證，依 id 對應）
{"v":1, "kind":"res", "id": 3, "status": "ok",
 "payload": {"rlm_child_id":"…","name":"api-reviewer","session_dir":"…","model":"…"}}
{"v":1, "kind":"res", "id": 3, "status": "error", "error": "depth limit reached"}

// 3. Emit（guest → host，fire-and-forget，host 回 ack 以背壓）
{"v":1, "kind":"emit", "id": 4, "type": "display.diff",
 "payload": {"path":"src/a.rs","oldStr":"…","newStr":"…"}}
{"v":1, "kind":"ack", "id": 4}
```

**分派**：`BridgeServer` 收到 `req` → 查 `HostRequestHandlers[type]`（**現有 registry 原封重用**，含 `rlm.run`/`goal.*`/`agent_message.*`/`mcp.*`/`model.info` 全部 handler）→ handler 回傳 JSON → 回 `res`。`cellSourceCode` 注入：BridgeServer 持有當前 cell 的 code（對映 `handleHostRequest` 注入 `activeExecution.code`），供 subagent spawn 顯示歸因。新增 handler：`websearch.run`（§4.1）與 `display.*`（emit 專用，不進 req 路徑）；`deps.add` 延至 Phase 2（D15）。

**時序語意**：guest 端 `req` 為同步阻塞（預設 30s 逾時，`rlm::Error::Bridge` 回報）；cell 結束時 host 等待 in-flight handler 完成再收尾（對映 `HOST_REQUEST_DISPOSE_TIMEOUT_MS = 5000`）。**沒有 control-channel 死結問題**——bridge 與 cell 的 stdout 是兩條獨立通道，host 端 handler 在 TS event loop 處理，與 cell 進程無鎖依賴（REPORT §3.3）。

**對映現制的差異聲明**：現制 comm 允許 cell 結束後的 detached asyncio task 繼續發訊（`onLateSentAgentMessage` LRU 機制）；新制 cell 進程結束即斷線，**無 late message**——這是簡化（一個 cell 的 side effect 隨 cell 終結），`agent_message` 要在 cell 存活期間送出。此語意差異需寫進 prompt（§3）。

### 2.8 狀態層規格

- `state.json`：單一 JSON object `{ "<key>": <any JSON> }`；guest 寫入原子（tmp+rename）；單檔軟上限 8 MiB（超過時 `rlm::state::set` 回 `Error::State`，指示改用 blob）。
- `blobs/<name>`：任意 bytes；`keys()`/`list_blobs()` 供盤點。
- Host 只讀不寫（compaction 通知、TUI 檢視）；cell 串行執行保證無並發寫者。
- **無跨 session 還原邏輯**：檔案天然持久。取代 `<ipython_state_restored>` 的是 resume 首輪注入：

```
<rust_state_restored>
Your persistent workspace was restored. state keys: {keys}. agent_lib public API: {fns}.
</rust_state_restored>
```

（`{fns}` 由 host 對 `agent_lib/src` 做輕量掃描：`pub fn` 簽名列表；Phase 2 換 rustdoc JSON。）

### 2.9 Rich output 與串流

Emit 事件 → `CellEmitEvent` → 直接餵進現有管線的三個型別（`KernelDiffDisplay`/`KernelAttachment`/`KernelSentAgentMessage`，型別沿用、來源從 iopub MIME 換成 bridge emit）：

| Guest API | emit type | 對映現制 MIME | 限制（沿用） |
|---|---|---|---|
| `rlm::display::diff(path, old, new)` | `display.diff` | `…diff+json` | — |
| `rlm::display::attach_image(path)` | `display.attachment` | `…attachment+json` | base64 ≤ 350K（guest 端縮圖至 1200px，移植 attach-image skill 邏輯）；host 硬上限 10M |
| `rlm::msg::send*` | （走 `req` 路徑 `agent_message.send`） | `…agent-message+json` | — |

TUI 渲染：`rust-cell.ts` 元件（§7 WP4）顯示 code（syntax highlight）、串流輸出、diff 卡片、耗時（`compile 0.3s · run 0.01s`）。

### 2.10 `bash` 工具與信任邊界

- 啟用既有 `tools/bash.ts` 為第二個內建工具（`allToolNames = {"rust", "bash"}`）。
- 描述文字補一句分工聲明："Use bash for the project's own commands (tests, builds, package managers). Use rust cells for your own computation."
- 可疊加 OS sandbox：sandbox extension 範例原樣可用（它就是包 bash 的）。
- Approval 政策沿用 prime-agent 現制（bash 工具本身的確認機制）；不在本設計新造。

---

## 3. Prompt 設計

### 3.1 組裝結構（沿用，僅換件）

`buildSystemPrompt` 的組裝順序不動（REPORT §1.9）；`buildRlmPrompt` 換成 `buildRustRlmPrompt`，其餘（harness 區塊、`# Additional Guidance`、Project Context、skills XML）沿用。動態段落對照：

| 現制 | 新制 |
|---|---|
| `Pre-installed Python packages: …` | `Prelude crates: {serde, serde_json, regex, anyhow, chrono, walkdir, …}` |
| `Install additional packages with uv pip install` | `Add crates with rlm::deps::add("name") (host-mediated, wasm-compatible only)` |
| `Installed Python skill modules (pre-imported): …` | `Skills available under agent_lib::skills::{…}` |
| `<available_skills>` 的 `<python_import>` | `<rust_use>` |

### 3.2 `RUST_CONTROL_PROMPT` 草案全文（英文，模型可見）

對映 `IPYTHON_CONTROL_PROMPT`（4,157 字元）逐條重構；粗體標記與 Python 版的心智模型差異點：

```
The rust tool is your control environment: you submit one complete Rust program (a "cell")
per call. It is compiled to wasm32-wasip1 and runs in a WasmEdge sandbox that can see
/workspace (the project), /agent (your persistent library and state), and /scratch.

A cell is a complete program, not a REPL fragment. Start with
`use agent_lib::prelude::*;` and write `fn main() -> Result<()>`. Use `?` freely.
**Variables do not persist between cells.** Persistence has three explicit layers instead:

1. Small data (findings, parsed results, counters, notes, plans):
   `rlm::state::set("key", &value)?` and `let v: Option<T> = rlm::state::get("key")?`.
   State survives cells, turns, compaction, and session restarts. Before re-deriving
   anything, check `rlm::state::keys()?`.
2. Reusable logic: extend your persistent library (crate `agent_lib`, read-only mounted
   at /agent/lib) by passing `lib` files alongside your cell code — they compile together
   with the cell and the same call can already use them. Prefer growing the library over
   re-writing helpers inside cells: cells should read as glue over agent_lib calls.
   If a lib edit fails to build, the files are reverted and the cell does not run —
   extend the library in small, compiling steps.
3. Large data: files under /agent/state (yours) or /workspace (the project's).

Compile errors are normal feedback, not failures. The tool returns rustc diagnostics;
fix the program and resubmit the complete cell. Runtime output returns stdout and stderr
(each truncated at 65536 chars) — print what you need to observe.

Do not assume the sandbox is the native runtime of the thing you are working on.
A repository, package, service, or dataset has its own environment and normal interface.
Run project imports, tests, scripts, CLIs, builds, and dependency checks through the
project's own environment with the bash tool (e.g. `npm test`, `cargo test`,
`uv run ...`), and treat failures from that native environment as the relevant result.

Use rust cells — not bash — for reading, searching, and editing files: the prelude has
read_lines, grep, walk, and edit_exact, and results persisted into rlm::state can be
revisited without re-reading. Reserve bash for the project's own commands, not for file
exploration. Use rust cells to decide what to run and to analyze what comes back.

Example — one call that grows the library and uses it immediately:
  lib: src/helpers/logs.rs
      use crate::prelude::*;
      #[derive(Serialize, Deserialize)]
      pub struct ErrorStats { pub by_kind: BTreeMap<String, u64> }
      pub fn scan_errors(path: &str) -> Result<ErrorStats> { /* read + regex + count */ }
  code:
      use agent_lib::prelude::*;
      fn main() -> Result<()> {
          let stats = helpers::logs::scan_errors("/workspace/app.log")?;
          for (kind, n) in stats.by_kind.iter().take(5) { println!("{n:>6}  {kind}"); }
          rlm::state::set("log_error_stats", &stats)?;
          Ok(())
      }

Capabilities are ordinary Rust calls returning Result, composable into program logic:
- `let h = rlm::spawn("sub-task")?;` admits a child agent and returns immediately with
  a handle (rlm_child_id, name, session_dir, model). It NEVER waits for or returns the
  child's answer; results arrive later through agent messages or files. Name children
  with `rlm::spawn_named("task", "api-reviewer")?`. Spawn independent children in one
  cell, persist their handles into state, then end your turn instead of waiting.
- `rlm::msg::send_to_parent("…")?` replies to your parent when a task calls for an
  answer; `rlm::msg::list_agents()?` discovers family. Send messages before the cell
  ends — a cell's side effects end with the cell.
- `rlm::goal::*`, `rlm::compact::*`, `rlm::refine::*`, `rlm::heartbeat::*` manage
  long-running work (same contracts as the harness documents them).
- `rlm::display::diff(path, old, new)?` and `rlm::display::attach_image(path)?` show
  rich output to the user.
- Continual harness state: `rlm::harness::*` (memories, skills, prompt notes, subagent
  specs). Keep refinements small and evidence-backed; call `rlm::refine::run(None)?`
  when a repeated failure or reusable tactic emerges.

Prelude crates available: {PRELUDE_LABELS}. This set is fixed: you cannot add
dependencies yourself. If a task genuinely needs another crate, tell the user (they can
extend the prelude in settings). Do not work around this by making the sandbox
impersonate the project environment — the project's own tooling runs via bash.

Editing project files: for targeted edits prefer
`edit_exact("/workspace/src/a.rs", old, new)?` from the prelude (exact-match replace,
emits a diff to the user); write whole files with std::fs when generating them.
```

（`{PRELUDE_LABELS}` 由 `WorkspaceManager` 注入，對映 `DEFAULT_RLM_EXTRA_IMPORT_LABELS` 機制。）

### 3.3 遞迴/child/refine 段落

- `buildSubagentGuidance`、child doctrine（`[task from parent]` 標籤、回覆紀律）語意照抄，僅把 call form 換成 `rlm::spawn` / `rlm::msg::send_to_parent`。
- Refine 段落與 harness 區塊的三個 call-contract 變體（refinement.ts:457-461）新增第四變體 `includeRustExamples`，Phase 1 起取代 ipython 變體。

### 3.4 Prompt 尺寸預算

對映現制固定本體 ~10–11KB：`RUST_CONTROL_PROMPT` 草案 ~3.4KB + few-shot 範例 ~0.6KB（D17，PoC A/B 決定去留）+ 開頭段/working dir ~0.8KB + subagent ~0.8KB + harness header ~3.6KB ≈ **9.2KB（~2,350 tokens）**，仍略小於現制。原因：%%bash/%cd/%env、kernel restart、dill 回復等 Python 專屬教義消失；新增的 cell 模型教義較短。

---

## 4. Skills 與自我改進

### 4.1 Skills-as-crates 規格

**偵測**（對映 `detectPythonSkill`，`skills.ts:202-254`）：skill 根目錄含 `SKILL.md` + `Cargo.toml` + `src/lib.rs` → `SkillKind: "rust"`；crate 名 = skill name 的 `-`→`_`（沿用 importName 規則與驗證）。`pyproject.toml` 偵測留存（fork 後 Python skills 降為不支援、給明確診斷）。

**掛載**（取代 venv editable install）：`WorkspaceManager.syncRustSkills()`：

1. workspace `Cargo.toml` 的 members 加入 `[skills 目錄的 path dependency]`（path 指向 skill 原地，**不複製**——等價 editable 語意：改 skill 原始碼、下個 cell 重編譯即生效，0.3s）。
2. `agent_lib/src/skills/mod.rs` 生成 `pub use <crate> as <name>;` re-export。
3. 變更偵測：skill `Cargo.toml` hash 進 `.workspace-version`（對映 `pyprojectHash` 機制）；skill 依賴需通過 vendored registry 或觸發一次 `deps.add` 流程。
4. 失敗策略沿用：單一 skill 編譯失敗 → 從 members 移除 + 警告診斷（不可拖垮整個 workspace——對映「install failure only warns」）。
5. 掛載範圍（定案）：發現到的 skills **全部掛載**（對映現制全裝進 venv + 全 pre-import）；bundled skills 預編譯進模板，user/project skills 首次進 session 時編譯一次。

**Prompt 呈現**：`<available_skills>` XML 沿用，`<type>rust</type>`、`<rust_use>agent_lib::skills::websearch</rust_use>`；`help()` 內省的替代＝SKILL.md 記載簽名（skill-creator 模板強制）+ Phase 2 rustdoc JSON 查詢。

**Bundled skills 的處置**（REPORT §3.4 的表格落地）：

| 現制（13 個） | 新制 |
|---|---|
| goal / agent-message / agent-observe / rlm-heartbeat / compact / refine（host-bridge 薄殼 ×6） | **消失**——成為 `rlm` crate 內建模組（§2.6），零安裝零發現成本 |
| edit | prelude 函式 `edit_exact()`（≈40 行 Rust + diff emit） |
| attach-image | `rlm::display::attach_image`（縮圖邏輯移植 ≈120 行） |
| websearch | rust skill crate（經 `rlm::host_request("websearch.run", …)` 新 handler 走 host 的 Serper key——**key 不進沙箱**，優於現制 `SERPER_API_KEY` 直接注入 kernel env） |
| linear / notion（MCP-backed） | `rlm::mcp::call_tool`（host MCP manager 沿用） |
| prime-intellect / skill-creator（markdown） | skill-creator 全文改寫為 Rust skill 授權指南（§4.3）；prime-intellect 移除 |

### 4.2 agent_lib 自我擴充迴路

模型把重複邏輯升格為函式的完整循環（這是「自我改進」在語言層的形態；D14 宣告式）：

1. 工具呼叫附 `lib` 參數新增 `src/helpers/log_parse.rs`（host 自動維護 `helpers/mod.rs` 的 `pub mod` 宣告，或模型將 mod.rs 一併列入 lib 參數）；**同一呼叫的 cell 立即可 `use`**——lib 與 cell 同次編譯。
2. Guard 即編譯步驟：lib 編不過 → 回滾＋診斷、cell 不跑（§2.1）——迴路天然強制「小步、可編譯」。
3. 升格為正式 skill：skill-creator 指南教模型把成熟的 helpers 搬出成獨立 skill crate + SKILL.md + `#[cfg(test)]` 測試，host 提供 `skills.package` host request 做 scaffold。
4. **品質閘（D19 定案：Phase 1 soft、Phase 2 強制）**：Phase 1 僅教義要求（refine prompt 與 skill-creator 指南要求先跑 `cargo test`）；Phase 2 以沙箱內測試（`cargo test --target wasm32-wasip1`、wasmedge 為 test runner）升級為 refine `create_skill` handler 的硬驗證。注意：host 在 native 跑模型寫的 test 等於繞沙箱執行任意代碼——**強制閘只能以沙箱內測試實作**，這是 D19 分期的根本原因。

### 4.3 Harness / refine 修改

- Schema：`reference.type` 接受 `"rust"`；`reference` 欄位 `{type:"rust", use:"agent_lib::skills::x", callable:"run", call_pattern:"agent_lib::skills::x::run(…)?"}`。驗證雙點同步改：`refinement.ts:684-703` 與 guest `rlm::harness`（取代 `harness.py:128-138`）。既有 `"python"` entry 讀取相容（顯示為 legacy、不可新建）。
- `REFINEMENT_SYSTEM_PROMPT`：skill/subagent 段的 call form 換為 `agent_lib::skills::<x>` 與 `rlm::spawn("…")`；「Do not invent wrappers」條款保留原文精神。
- `/refine` 流程、快照/回滾、auto-refine 治理（25 turns / 20min cooldown / compact 觸發）**零修改**。

---

## 5. 遞迴 subagent 與長任務功能

### 5.1 rlm.spawn 遞迴

Host 端 `AgentSession.runRlmChild()` 的 8 步流程（depth 檢查→model 解析→sub-xxxxxxxx 目錄→admission→child runtime→usage 歸帳）**零修改**——它只認 JSON payload。變更僅：

- Child 的 kernel env 鍵沿用（`RLM_DEPTH`、`RLM_MAX_DEPTH`、`RLM_SESSION_DIR`…），由 `RustCellManagerOptions.env` 傳遞。
- Child 是完整 `AgentSession` → 自帶自己的 workspace（`sub-xxxxxxxx/workspace/`）。**繼承策略（D18 定案：spawn 時快照複製）**——child workspace 從 parent 當下的 `agent_lib`（含 helpers 與 skills 掛載）clonefile/reflink 複製，target 快取一併複製（child 首 cell 仍熱）；之後各自演化互不干擾。fan-out 模式「parent 建工具、children 分段執行」因此成立；fan-in 仍走檔案/訊息。child 的 `state/` 從空開始（context 隔離不變）。
- `spawnCode` 歸因：BridgeServer 注入當前 cell code（§2.7）。

### 5.2 Goals / heartbeat / autonomous / compaction

- Goals：`goals.ts` 核心零修改；兩處工具名檢查（`"ipython"` → `"rust"`，含 active-goal 強制啟用邏輯 `agent-session.ts:8610-8613`）。
- Heartbeat/cron/autonomous：零修改（探索確認 runtime-agnostic）。
- Compaction：演算法零修改；`KERNEL_PERSIST_SUMMARY_NOTE` 改寫為「rlm::state 與 agent_lib 在 compaction 後保留，把 state keys 與常用函式記進摘要」；`_notifyKernelStateAfterCompaction` 改呼叫 `listPersistentState()`（§2.2）注入：

```
<rust_state>
Your workspace persisted through compaction. state keys: {keys}. agent_lib API: {fns}.
</rust_state>
```

### 5.3 MCP

`mcp-manager.ts` 沿用；呈現層從「動態生成 Python skill」改為 `rlm::mcp` 模組 + skills XML 列出可用 server（`mcp.list_tools`/`mcp.call_tool` host request 型別不變）。

---

## 6. Phase 0：PoC 詳細設計

**目的**：在真 prime-agent（未 fork）上回答唯一的高風險問題——**模型能否以 cell=program 模式有效工作**（REPORT §6 風險 1）。範圍刻意砍到最小可量測。

### 6.1 載具與目錄

```
wasmedge-agent/
├── poc/
│   ├── extension/
│   │   ├── package.json         # {"pi":{"extensions":["./index.ts"]}} + 自帶 deps
│   │   ├── index.ts             # registerTool("rust") + registerTool("bash")
│   │   │                        # + before_agent_start（整段換 prompt）
│   │   │                        # + session_start/shutdown（起停 CellRunner）
│   │   └── runtime/
│   │       ├── cell-runner.ts   # §2.2 的極簡版：scaffold+compile+run+state 通知
│   │       └── workspace.ts     # 模板複製、lib 參數套用/回滾（D14）；git commit 可先砍
│   ├── guest/
│   │   ├── rlm/                 # 只含 state + display::diff stub + prelude
│   │   └── template/            # workspace 模板（Cargo.toml、agent_lib、cell）
│   └── bench/                   # §6.3
```

啟動：`prime-agent --no-builtin-tools --skill …/poc/extension`（extension 註冊 `rust` 與 `bash`——bash 從 SDK 匯出的 `createBashTool` 取得，sandbox 範例已示範此用法）。

**PoC 範圍界定**（明確不做）：無 BridgeServer/spawn/msg/goal（單 agent 任務）、無 TUI 自訂渲染（吃預設文字渲染）、無 skills、無 deps.add（prelude 鎖死）。**做**：cell 編譯執行迴路、`rlm::state`、agent_lib 自我擴充 + guard、prompt v0、串流。

### 6.2 對照組

| 組 | 設定 |
|---|---|
| A（baseline） | 原版 prime-agent，ipython runtime，**預設全功能形態**（不做任何削弱——對照誠實） |
| B（treatment） | 同版本 + PoC extension（rust + bash，prompt 換裝） |

任務環境用**固定 fixture repos**（版本 pin、每 run 從乾淨副本開始）——可重現、兩組公平。

同模型、同任務、同 settings；每 (任務, 模型, 組) 跑 3 次取中位。模型：Claude（sonnet 級與 opus/fable 級各一）+ 一個開源權重模型（經 openrouter），共 3 家交叉驗證（REPORT §6 風險 7）。

**Treatment 組內部 sub-A/B（D17）**：prompt 有/無 few-shot 範例兩版各跑一半，判準為首個 cell 的 compile-error 率與整體修錯輪數；勝者定案進 Phase 1 prompt。此 sub-A/B 不增加對 baseline 的比較組數。

### 6.3 Benchmark 任務集（12 項）與量測

任務類別（每類 2–3 項，各附自動驗收腳本 `check.sh`，退出碼判定成功）：

1. **檔案/文本處理**：log 解析統計、多檔 grep-and-transform、CSV→JSON 正規化。
2. **程式修改**：中型 repo 定位並修 bug（測試轉綠）、跨檔 rename 重構。
3. **多步驟 + 狀態重用**：兩回合任務——第一回合分析（結論入 state）、使用者追問後第二回合基於 state 續作（**專測持久層 ergonomics**）。
4. **工具鏈組合**：跑專案測試→解析失敗→修→複跑（bash+rust 分工）。
5. **能力累積**：三個相似小任務連發，觀察模型是否把共用邏輯升格進 agent_lib（**專測自我擴充迴路**）。

指標（全部可從 session JSONL 離線萃取，`bench/analyze.ts`）：

| 指標 | 來源 | Phase 1 放行閾值 |
|---|---|---|
| 任務成功率 | check.sh | ≥ baseline − 15pp |
| 每任務 token（in/out 分列） | usage entries | ≤ 2.0 × baseline |
| 每任務 cell 數與 compile-error cell 佔比 | tool results | 觀測值（無閾值；預期 error 佔比 20–40%） |
| 每 cell 端到端延遲 p50/p95 | details.durationMs | p50 ≤ 1s |
| 修錯收斂：compile error 後至成功的平均輪數 | 序列分析 | ≤ 2 |
| 質性：state/agent_lib 使用率、每 cell 重算率 | 人工複盤 trajectory | 報告記錄 |

**Exit 判準（D20 已確認）**（→ Phase 1 GO）：成功率與 token 閾值同時達標於 ≥2 家模型；未達標 → 回修 prompt/prelude 一輪（≤1 週）再測；仍未達 → 升級決策（範圍收窄為 systems-agent 場景或轉選項 C 重新評估）。模型組合依 D21：Claude sonnet 級 + opus/fable 級 + 開源權重一家。

---

## 7. Phase 1：Fork 手術計畫

### 7.1 Repo 策略

- **（D22 定案）**M1 GO 後 fork `PrimeIntellect-ai/prime-agent` → **`hydai/wasmedge-agent`**（個人 repo 低調進行，失敗成本低）；M5 MVP 驗收通過後 transfer 至 second-state org 正式化。保留 `upstream` remote。
- **（D23 定案）**不向上游探詢 runtime 抽象層意願，直接獨立 fork——自主性與差異化窗口優先，接受長期 SYNC 稅（§7.3 即為此而設計）。
- Package 更名：`@earendil-works/pi-*` 依賴關係保留（沿用上游做法——他們 fork 後也沒改依賴名），只改 `coding-agent` 的 bin 名與品牌字串；正式命名見 §11 D10。
- PoC 產物遷移：`poc/runtime/*` 升格為 `packages/coding-agent/src/core/rust-cell/`；`poc/guest/` 升格為 repo 頂層 `wasmedge-agent-runtime/`（位置對映 `prime-agent-runtime/`，`copy-assets` 腳本同機制打包模板）。

### 7.2 工作包分解（WP1–WP9，依 REPORT §1.12 耦合表逐項對應）

| WP | 內容 | 動作對象 | 規模/依賴 |
|---|---|---|---|
| **WP1 骨架** | 刪 `core/kernel/`（index/bootstrap/fork-server/state-snapshot/boot-gate，3,329 行）與 `prime-agent-runtime/`；`tools/index.ts` 咽喉點改 `ToolName = "rust" \| "bash"`；`cli/args.ts` `BUILTIN_TOOL_NAMES`；刪 zeromq 依賴 | 刪除為主 | 3 天；無依賴 |
| **WP2 Cell 引擎** | `core/rust-cell/`：WorkspaceManager、CompilePipeline、ExecPipeline、compile gate、`tools/rust.ts`（§2.2–2.5）；PoC 程式碼工業化（逾時/中斷/串流/git 守護） | 新寫 ~3K | 1.5 週；WP1 |
| **WP3 Bridge** | BridgeServer + 協議 v1（§2.7）；`_createKernelHostHandlers` 改接 BridgeServer（handler 本體零改）；guest `rlm` crate 全模組（§2.6）；`websearch.run` 新 handler（deps.add 不做——D15） | 新寫 ~1.5K TS + ~1.5K Rust | 1.5 週；WP2 |
| **WP4 呈現層** | `prompts/rust-rlm.ts`（§3 定稿）；`system-prompt.ts` 的 `hasIpython`→`hasRust` 分支；`code-preview.ts` Rust regex；`rust-cell.ts` 渲染元件（取代 ipython-cell.ts 712 行）；`tool-execution.ts`/`interactive-mode.ts` 分派；ACP 對映（title "Rust cell"、`_meta` 鍵） | 重寫 ~1.5K | 1 週；WP2 |
| **WP5 狀態通知** | compaction/resume/goal 通知改寫（§5.2、§2.8）；`agent-session.ts` 85 處耦合點清理（provisioner 型別、`_onIpythonStateRestored`→`_onWorkspaceRestored`、late-message 機制刪除、prewarm 改 workspace ensure） | 散改 | 1 週；WP2–3 |
| **WP6 Skills** | `skills.ts`：`SkillKind: "rust"` 偵測/掛載（§4.1）；`syncRustSkills`；bundled skills 替換（6 個入 crate、edit/attach 入 prelude、websearch crate、MCP 模組）；skill-creator 改寫 | 改 ~0.6K + 新 Rust | 1 週；WP3 |
| **WP7 Harness** | `reference.type: "rust"` 雙點驗證、refinement prompts 更新、`rlm::harness` 移植（mtime 同步） | 改 ~0.3K | 3 天；WP3 |
| **WP8 安裝/組態** | installer（venv 段 → rustup target + wasmedge 檢查 + 模板預建 + vendor）、postinstall、doctor 增 toolchain 檢查、env vars 更名（§10）、docs 全面改寫（rlm.md/rlm-runtime.md/skills.md/quickstart/…） | 改寫 | 1 週；WP2 |
| **WP9 測試/驗收** | 17 個 kernel 測試檔替換為 rust-cell 套件（§9）；faux-provider suite 適配；dogfood 驗收 | 測試 | 1 週；全部 |

關鍵路徑：WP1→WP2→WP3→WP5→WP9（約 6 週）；WP4/WP6/WP7/WP8 可並行插入（單人全職總計 7–8 週，與 REPORT 估計一致）。

### 7.3 上游同步策略（`SYNC.md`）

- **我方獨占區**（上游永不碰）：`core/rust-cell/`、`prompts/rust-rlm.ts`、`wasmedge-agent-runtime/`、`rust-cell.ts` → 零衝突。
- **上游直收區**：`packages/{ai,agent,tui}`、daemon/session/cron/autonomous → 每月 cherry-pick 窗口直接收。
- **手術點清單**：`SYNC.md` 維護散改點（agent-session 85 處、system-prompt、skills.ts、tools/index、ACP…）的 our-side diff 摘要；上游動到這些檔案時按清單人工 rebase。
- 上游大版本（minor：API breaking）→ 開一次專門的同步衝刺評估。

---

## 8. Phase 2：概要設計

### 8.1 T2 Runner（host functions 形態）

一個 ~1K 行的 Rust binary `wasmedge-cell-runner`，內嵌 WasmEdge（C API）：

- Host module `rlm_host`：`host_request(ptr,len)→(ptr,len)`、`emit(kind,ptr,len)`、`log(ptr,len)`；guest `rlm` crate 的 bridge 後端從 socket 換 host function（**crate API 不變**，cell 程式零感知——這是 §2.6 全同步 API 設計的回報）。
- Runner ↔ TS host：stdio JSON-RPC（協議 v1 語意平移；框架欄位 `kind` 沿用）。
- 新能力：gas metering（statistics cost limit，`cellGasLimit` 設定）、memory page limit、`WasmEdge_Async*` cancel（interrupt 不再 SIGKILL、可拿部分輸出）、**deny-by-default 網路成為運行時強制**（guest 無 socket 能力，一切 I/O 過 host module）。
- 部署：runner 隨 npm 包分發 prebuilt binaries（對映上游 build-binaries.yml 機制）。

### 8.2 其他

- **Curated deps.add（D15 後續）**：已驗證 wasm32-wasip1 相容的白名單（估 30–80 個常用 crate）；`rlm::deps::add` 限白名單內，host 抓取 → re-vendor → 改 Cargo.toml → commit。
- **AOT 快取**：`agent_lib` 與 skills 變更時背景 `wasmedge compile`；cell 仍 interpreter（短命，AOT 不划算）。
- **rustdoc JSON 內省**：`listPersistentState` 與 skills XML 的 API 列表改由 rustdoc JSON 供給。
- **Workspace 唯讀模式**：`workspaceWritePolicy: "rw" | "ro"`；ro 時 `/workspace:ro` + 教義改為產 patch 由 host apply（RL replay 前置）。
- **沙箱內測試**：`cargo test --target wasm32-wasip1` + wasmedge test runner；並依 D19 升級 refine `create_skill` 為硬驗證（test 綠才准建 harness skill entry）。
- Windows 評估、polars wasm 驗證（研究場景擴張的前提）、component model 追蹤（skills as components）。

---

## 9. 測試與驗證策略

| 層 | 內容 | 工具/位置 |
|---|---|---|
| 單元（TS） | workspace scaffold/版本 marker/守護回滾、compile 診斷解析、bridge framing/token/逾時、state 通知組裝 | vitest，`core/rust-cell/*.test.ts` |
| 單元（Rust） | `rlm::state` 原子性、harness mtime 同步、display 縮圖、error 對映 | `cargo test`（native target 跑 guest 邏輯，bridge 以 mock） |
| 整合 | 真 cargo+wasmedge 的 cell 往返（成功/編譯錯/panic/逾時/中斷）、bridge e2e（fake handlers）、lib guard 回滾、resume 後 state 通知 | 專用 CI job（裝 rustup target + wasmedge；~2 分鐘） |
| Suite | 沿用 `test/suite/harness.ts` + faux provider：腳本化模型回覆驅動 `rust` tool 全流程（**不花真 token**，上游既有機制） | `test/suite/rust-cell/` |
| 回歸 | 對映上游 `regressions/` 慣例 | 同上游 |
| 驗收 | Phase 0 bench 集在 fork 上複跑（成績不得低於 PoC）；dogfood：用 wasmedge-agent 開發 WP6–WP8 | 人工 + bench |

CI 注意：kernel 測試刪除後，上游 `test:kernel` script 位置換 `test:rust-cell`；macOS + Linux runner 各跑整合層。

## 10. 組態與部署

**Env vars**（對映現制 7 個 `PRIME_AGENT_KERNEL_*`）：

| 新 | 語意 | 對映 |
|---|---|---|
| `WASMEDGE_AGENT_WASMEDGE` | wasmedge 執行檔路徑覆寫 | `PRIME_AGENT_KERNEL_PYTHON` |
| `WASMEDGE_AGENT_TOOLCHAIN` | cargo/rustup 路徑覆寫 | — |
| `WASMEDGE_AGENT_TEMPLATE_DIR` | workspace 模板位置 | `PRIME_AGENT_KERNEL_VENV` |
| `WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS` | compile gate | `…MAX_CONCURRENT_KERNEL_BOOTS` |
| `WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL` | postinstall 預建模板/vendor | `…BOOTSTRAP_KERNEL_ON_INSTALL` |

**settings.json** 新段：

```jsonc
"rustCell": {
  "cellTimeoutMs": 120000,
  "workspaceWritePolicy": "rw",      // "ro" 於 Phase 2
  "preludeExtra": [],                 // 追加 crate（仍過 wasm 相容檢查）
  "cellGasLimit": null                // Phase 2（T2）
}
```

**Installer/doctor**：installer 的 kernel 段改為（a）rustup + `wasm32-wasip1` target 檢查/引導安裝、（b）wasmedge 檢查/引導（官方 install script）、（c）模板 workspace 預建 + `cargo vendor`（一次性 ~1–2 分鐘，對映現制 "setting up python kernel (one-time, ~30s)"）；`doctor` 增列 toolchain/模板/vendor 三檢查與 `--fix`。

## 11. 決策記錄

| # | 決策 | 理由 / 替代案 |
|---|---|---|
| D1 | Cell 語言僅 Rust（Phase 0–2） | 聚焦教義與 prelude 品質；`CompilePipeline` 保持 driver 介面（語言→toolchain 命令）以備擴充。替代案「任何 wasm 語言」推遲到 component model 時代 |
| D2 | `/workspace` 預設可寫 | 與現制行為對齊、PoC 對照公平；ro+patch 模式為 Phase 2 選項（RL 場景再啟用） |
| D3 | 傳輸 T1（socket）起步、T2（host functions）定型 | REPORT §3.3；guest API 同步化使切換零感知 |
| D4 | Bridge 認證用 bearer token（非 HMAC 逐訊息簽章） | loopback + 每 session 隨機 64-hex token，威脅模型同 Jupyter token auth；簡化 framing |
| D5 | Workspace git 版本化 + agent_lib guard | 防磚、可審計、replay 基礎；成本僅每 cell 一次 commit（<10ms） |
| D6 | 工具名 `rust`（不冒名 `ipython`） | 冒名會觸發上游 `hasIpython` 的全套 Python prompt（探索確認）；誠實命名 + fork 內改分支條件 |
| D7 | Prompt 全新創作、面向通用 frontier models | 上游 base prompt 是「訓練過的前綴」，模仿無利；REPORT §3.6 |
| D8 | 押 wasm32-wasip1 core module；CM/wasip2 列 Phase 3 | Rust tier-2 穩定 + WasmEdge 最成熟路徑；REPORT 附錄 B |
| D9 | T1 期 guest 網路能力=僅 bridge（crate 層約束，非運行時強制） | 誠實記錄：safe Rust + 我方 crate 下有效，惡意 cell 可繞過（unsafe/自帶 socket 呼叫）→ 運行時強制是 T2 的明確動機，文件不得在 T1 期宣稱 deny-by-default 已達成 |
| D10 | 工作名 wasmedge-agent；正式命名延後到 M5 轉 org 時定案 | 原「開 issue 探詢上游」建議由 D23 否決取代；命名部分維持延後 |
| D11 ✅ | 接受「無長命進程 → 大資料跨 cell 重讀」語意 | 緩解：state/blobs 序列化中間結果；resident data service 不預先設計，待實證瓶頸再議（§1.2） |
| D12 ✅ | Guest 對外 I/O 一律 host-mediated——**產品原則，非過渡措施** | 一切 fetch/search 類能力以 host handler 擴充（websearch 模式）；guest 永不直連外網。決定性/replay/credential 隔離三重理由（§1.3 原則 4、§2.7）。D9 的 T1 強制力缺口仍如實記載 |
| D13 ✅ | `rust` + `bash` 雙內建工具 | 沙箱涵蓋 agent 自身計算、bash 為顯式越權通道的誠實敘事（§2.10）；與上游能力對齊、PoC 對照公平。approval 政策沿用現制 |
| D14 ✅ | agent_lib 擴充走**宣告式 `lib` 參數**；`/agent/lib` 唯讀 preopen | 免 Rust-in-Rust 字串轉義、省 token；guard 併入編譯步驟（lib 編不過 → cell 不跑、原子回滾）→ workspace 恆處可編譯狀態；lib diff 免費渲染。代價：雙參數 schema、cell 內不能程式化生成 lib（經 state 中轉） |
| D15 ✅ | Phase 1 prelude 鎖死；`deps.add` 延至 Phase 2 curated 白名單 | 供應鏈面最小、WP3 縮小、決定性最強；使用者以 settings `preludeExtra` 調整。Phase 2 白名單：host 抓取 → re-vendor → commit |
| D16 ✅ | 檔案操作教義 rust-first | 讀/搜/改檔走 rust cell（prelude helpers + state 重用），bash 保留給專案原生指令——RLM 理念的直接平移；代價為 cell 數增加，PoC 質性觀察項 |
| D17 ✅ | Prompt 附一個完整 few-shot 範例；PoC treatment 組內 sub-A/B 定去留 | +~150 tokens 固定成本 vs 首錯率——用數據定案而非直覺（§3.2 範例、§6.2 sub-A/B） |
| D18 ✅ | Child spawn 時快照複製 parent 的 agent_lib（含 target 快取）；`state/` 從空開始 | fan-out「parent 建工具、children 分段執行」成立；複製毫秒級、之後各自演化零耦合；context 隔離不變（§5.1） |
| D19 ✅ | Skill 品質閘：Phase 1 教義要求（soft）、Phase 2 沙箱內 cargo test 硬驗證 | host native 跑模型寫的 test = 繞沙箱執行任意代碼——強制閘只能以沙箱內測試實作，故分期（§4.2、§8.2） |
| D20 ✅ | GO/NO-GO 閾值維持：成功率 ≥ baseline−15pp、token ≤ 2.0×、≥2 家模型同時達標 | 容忍中度折價換沙箱/型別化/決定性的長期優勢；閾值是止損線非目標（§6.3） |
| D21 ✅ | PoC 模型組合：Claude sonnet 級 + opus/fable 級 + 開源權重一家（~216 runs、$200–600） | 主力情境＋能力上限＋跨家普適性各取一點；開源家兼作 LlamaEdge 故事前哨（§6.2） |
| D22 ✅ | M1 GO 後 fork 至 `hydai/wasmedge-agent` 個人 repo；M5 驗收通過後 transfer 至 second-state org | 低調驗證、失敗成本低、不背品牌期待；轉移的 star 歸零影響小（§7.1） |
| D23 ✅ | **不探詢上游**，直接獨立 fork | 使用者裁定（否決「帶 PoC 數據去談」的建議案）：自主性與差異化窗口優先於潛在省工；SYNC 稅由 §7.3 三區策略承擔 |

**審閱記錄**：
- 2026-08-06 第 1 輪（§1 總體架構）——D11/D12/D13 確認；分層圖、進程模型、原則 1–5 無異議成立。
- 2026-08-06 第 2 輪（§2 核心元件）——D14/D15 確認；另定案 `/agent/lib`+`/agent/state` 雙獨立 preopen、per-cell bridge 連線、cellTimeout 120s 預設。
- 2026-08-06 第 3 輪（§3 Prompt）——D16/D17 確認；組裝結構、動態段落對照、第四 call-contract 變體、尺寸預算（~9.2KB）成立。
- 2026-08-06 第 4 輪（§4–§5 Skills/遞迴）——D18/D19 確認；另定案 skills 全掛載；bundled 處置表、harness reference 規格、goals/compaction/MCP 平移無異議成立。
- 2026-08-06 第 5 輪（§6 PoC）——D20/D21 確認；另定案 fixture repos 固定化、baseline 全功能對照；載具、範圍界定、指標集成立。
- 2026-08-06 第 6 輪（§7–§12）——D22/D23 確認（D23 否決原 D10 的上游探詢建議）；WP 分解、SYNC 三區、Phase 2 概要、測試五層、組態、里程碑結構成立。**全文件審閱完成，狀態：已定稿（formalized）。**

## 12. 里程碑與時程

| 里程碑 | 內容 | 週次 | Gate |
|---|---|---|---|
| M0 | PoC 建置完成（extension + guest 雛形 + bench 集） | W1–W2 | — |
| M1 | **PoC 量測報告** | W3 | GO/NO-GO：§6.3 閾值 |
| M2 | Fork 骨架 + cell 引擎（WP1–2） | W4–W5 | cell 迴路 demo |
| M3 | Bridge + 遞迴 + 呈現（WP3–5） | W6–W8 | spawn/goal/compaction 全通 |
| M4 | Skills + harness + 安裝（WP6–8） | W9–W10 | skill-creator 迴路 demo |
| M5 | **MVP 驗收**：bench 複跑 + dogfood 開始 | W11 | §9 驗收層 |
| M6 | Phase 2 起點（T2 runner 設計評審） | W12+ | — |

人力假設：1 人全職；bench 需 API 預算（12 任務 × 3 模型 × 2 組 × 3 次 ≈ 216 runs，中型任務估 $200–600）。

## 13. 附錄

### A. Workspace 模板全文

```toml
# Cargo.toml（workspace root）
[workspace]
members = ["agent_lib", "cell", "rlm"]
resolver = "2"

[profile.release]
incremental = true

# .cargo/config.toml
[build]
target = "wasm32-wasip1"
[source.crates-io]
replace-with = "vendored"
[source.vendored]
directory = "/Users/…/.wasmedge-agent/vendor"
[net]
offline = true
```

```toml
# agent_lib/Cargo.toml
[package]
name = "agent_lib"
edition = "2021"
[dependencies]
rlm = { path = "../rlm" }            # 由模板攜帶的 guest shim
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
regex = "1"
chrono = { version = "0.4", default-features = false, features = ["clock", "serde"] }
walkdir = "2"
# prelude 集最終以 wasm32-wasip1 相容性驗證為準（§9 整合層鎖定）
```

```rust
// cell/src/main.rs（模板初始內容，示教形狀）
use agent_lib::prelude::*;

fn main() -> Result<()> {
    println!("workspace ready");
    Ok(())
}
```

### B. Bridge 協議訊息一覽（v1）

| kind | 方向 | 欄位 | 說明 |
|---|---|---|---|
| `hello` / `hello_ok` | G→H / H→G | v, token, cell | 握手；token 錯即斷線 |
| `req` / `res` | G→H / H→G | id, type, payload / id, status, payload\|error | 同步 host request；type 即現有 handler 鍵 |
| `emit` / `ack` | G→H / H→G | id, type, payload | display.diff、display.attachment |

逾時：req 30s（guest 端）；host 收尾等待 in-flight 5s。錯誤碼：`hello` 失敗、unknown type（"host request type X is not available in this session"——沿用現制訊息）、payload 驗證失敗（rlm-runtime.ts 既有驗證原樣觸發）。

### C. Benchmark 任務清單（Phase 0）

| # | 類別 | 任務 | 驗收 |
|---|---|---|---|
| 1–3 | 文本/資料 | nginx log 錯誤統計 top-N；多檔 TODO 掃描產 Markdown 報表；髒 CSV 正規化為 JSON | 輸出檔 diff |
| 4–5 | 程式修改 | 中型 TS repo 修 bug 至測試綠；Rust crate 跨檔 rename | 測試/`cargo check` |
| 6–7 | 狀態重用 | 兩回合：分析 repo 結構入 state → 追問時零重讀作答；三回合累積建立 log 分析 helper 並重用 | trajectory 檢查 state/lib 使用 |
| 8–9 | 工具鏈 | 跑測試→解析失敗→修→複跑；依 lint 輸出批次修風格 | 測試/lint 綠 |
| 10–12 | 綜合 | 小 CLI 從零生成含測試；兩資料源 join 報表；含錯誤注入的 fixture 修復 | check.sh |

### D. 參照文件

- 《REPORT.md》：可行性分析全文（耦合面、實測、路線比較）——本設計的依據。
- 上游文件對映：`docs/rlm.md`→ 需改寫、`docs/architecture.md` 圖 → §1.1 取代 kernel 框、`docs/extensions.md` → PoC 載具依據。

---

*設計方案已定稿（2026-08-06 六輪審閱完成，D1–D23 全數定案）。下一步：M0（PoC 建置）開工。*
