# WasmEdge Agent 可行性研究報告

**主題**：分析 Prime Agent（IPython-as-runtime 的自我改進型 agent），並評估以 **WasmEdge 作為 runtime、讓 agent 撰寫 Rust 進行開發與迭代** 的可行性與實作路線。

- 分析對象：`/Users/hydai/workspace/ss/prime-agent`（v0.7.0，HEAD `c22549a3`，MIT License）
- 撰寫日期：2026-08-06
- 實測環境：macOS（Darwin 25.5.0，Apple Silicon）、rustc 1.97.0、WasmEdge 0.17.1（本機 master build）

---

## 0. 摘要（Executive Summary）

**結論：可行，且不只是「把 Python 換成 Rust」的平移——WasmEdge + Rust 恰好補上 Prime Agent 自己明文承認的最大弱點（kernel 不是安全沙箱），並額外換來型別驗證、決定性執行與資源治理。代價是放棄 REPL 的即時求值與動態生態，改為「cell = 完整程式」的 compile-run 模型，並以顯式狀態層取代 in-memory namespace。**

四個關鍵發現：

1. **延遲不是問題（已實測）**。在本機量測：Rust cell 熱編譯（`wasm32-wasip1`，release，含 serde/serde_json）**0.28 秒**，WasmEdge 執行含狀態檔往返 **10ms**，冷編譯僅首次 4.8 秒。相對於 LLM 單輪推理的 5–60 秒，編譯延遲完全可忽略。
2. **架構上存在官方縫隙但不足以免 fork**。`AgentSessionConfig.baseToolsOverride` 註解明寫 "useful for custom runtimes"，可完全繞過 IPython；但 host bridge、goals、system prompt、skills、renderer 有數十處硬繫在 `ipython` 上（僅 `agent-session.ts` 就 85 處），乾淨的替換必須 fork。Prime Agent 本身就是 pi-mono 的 in-repo hard fork（四個 package 沿用 `@earendil-works/pi-*` 名稱）——「fork 一個完整 agent、換上自己的 runtime 理念」正是它自己的誕生方式。
3. **可重用比例高**。Provider 層（34K 行）、agent loop（2.4K 行）、TUI（15K 行）、daemon/sessions/compaction/goals 等與 Python 無關；需要重寫的集中在 kernel 層（~3K 行）、ipython tool（0.7K 行）、prompt 教義、skills 安裝機制與 renderer。Harness 狀態（`harness_state.json` schema v1）、`/refine` 編輯協議、SKILL.md 格式、compaction 演算法皆為語言中立、可直接沿用。
4. **語意對應有一處根本轉換**：IPython 的「持久 in-memory namespace」在 Rust/Wasm 沒有等價物。替代設計是三件套：**持久 workspace crate（程式碼即長期記憶）＋ 顯式狀態層（serde 檔案/KV，經 WASI preopen）＋ host bridge（host functions 或 loopback socket，1:1 對應現有 `host.request` comm 協議且更簡單）**。dill snapshot 的 best-effort 序列化在此模型下反而變成 100% 可靠——狀態本來就在檔案。

**建議路線**：三階段混合。Phase 0 用 SDK 的 `baseToolsOverride` 掛一個 Rust-cell 工具在原版 prime-agent 上跑真任務（不 fork、1–2 週），量測模型以 cell=program 模式工作的 token 成本與成功率；數據支持後 Phase 1 正式 fork 置換 runtime 層（4–8 週 MVP）；「從頭打造 Rust-native host」保留為 Second State 戰略選項（全 Rust 堆疊 + LlamaEdge/WASI-NN 本地推理），但成本高一個量級，不建議作為第一步。

---

## 目錄

1. [Prime Agent 完整分析](#1-prime-agent-完整分析)
2. [核心命題：IPython+Python → WasmEdge+Rust 的語意對應](#2-核心命題ipythonpython--wasmedgerust-的語意對應)
3. [設計藍圖：wasmedge-agent runtime](#3-設計藍圖wasmedge-agent-runtime)
4. [路線選擇：Fork vs Extension vs 從頭打造](#4-路線選擇fork-vs-extension-vs-從頭打造)
5. [分階段執行計畫](#5-分階段執行計畫)
6. [風險清單與開放問題](#6-風險清單與開放問題)
7. [附錄](#7-附錄)

---

## 1. Prime Agent 完整分析

### 1.1 專案定位與來源

Prime Agent 是 Prime Intellect 開源的 coding/research agent（自稱 "A Self-Improving RLM Agent"），設計圍繞兩個核心抽象：

- **RLM（Recursive Language Model）**：把 context 當變數（*prompt-as-a-variable*）、把工具與遞迴 subagent 當函式呼叫（*programmatic tool calling*），全部發生在一個**持久的 IPython REPL** 裡。
- **Continual Harness**：把補充 prompt、記憶、skill 描述、subagent 規格存成可持久、可回滾的狀態，讓 agent 透過小步、有證據的更新（`/refine`）自我改進——但**不可變的 base system prompt 永不被改寫**。

重要的族譜事實：Prime Agent 是 badlogic 的 **pi-mono 的 in-repo hard fork**。四個 package 直接沿用上游 npm 名稱（`packages/agent` = `@earendil-works/pi-agent-core`、`packages/ai` = `@earendil-works/pi-ai`、`packages/tui` = `@earendil-works/pi-tui`、`packages/coding-agent` = `@earendil-works/pi-coding-agent`）。Prime Intellect 對 pi 做的事——fork 一個完整的傳統 tool-based coding agent，把工具體系換成「一個 IPython 工具走天下」——**正是本報告評估要對 prime-agent 做的事**。這個先例證明此策略在工程上成立。

README 中的信任模型警告值得全文引用，因為它是 WasmEdge 方案的核心動機：

> "Prime Agent executes model-generated Python and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not** a security sandbox."

### 1.2 Monorepo 結構與規模

| 位置 | 內容 | TS/Py 行數 |
|---|---|---|
| `packages/ai` | 多 provider LLM 串流層：9 種 API 實作（anthropic-messages、openai-completions/responses、azure、codex、mistral、google-generative-ai、vertex、bedrock）、32 個內建 provider 定義、統一 `AssistantMessageEvent` 串流介面、開放註冊 registry | 34,013（含 ~20K 自動生成模型目錄） |
| `packages/agent` | Agent loop 核心抽象（工具定義、事件流、佇列） | 2,395 |
| `packages/coding-agent` | 主體：daemon、worker、kernel、session、TUI 模式、skills、harness、compaction、ACP/RPC | 115,565 |
| `packages/tui` | 終端 UI 框架 | 14,927 |
| `prime-agent-runtime` | **Python 端 shim**（`rlm` 套件：host bridge、harness store、skill CLI adapter） | ~1,205（`__init__.py` 347 + `harness.py` 820 + `skill.py` 38） |

另有 33 篇文件（`packages/coding-agent/docs/`）、13 個 bundled skills、範例 extensions。Node >= 22.8，Python kernel 環境由 `uv` 管理（Python 3.11）。

關鍵觀察：**Python 端出奇地薄**。整個「ipython as runtime」的模型端只有 1,200 行 shim；所有重活（provider 呼叫、子 agent 生命週期、持久化、政策）都在 TypeScript host。這個「thin guest shim + authoritative host」的設計是可移植的——guest 語言換成 Rust 不動搖架構。

### 1.3 程序架構

```
Interactive TUI ─┐
Print/JSON/RPC ──┤→ AgentConnection ⇄ Daemon supervisor（路由/attach/恢復）
                 │                        │
                 │                        ▼
                 │            Session worker（一棵 root session tree 一個進程）
                 │              ├─ AgentSessionRuntime → AgentSession（provider 呼叫、佇列、
                 │              │    工具、compaction、goals、child 生命週期、transcript）
                 │              ├─ Scheduler（heartbeat/schedule）
                 │              ├─ Root IPython kernel（獨立進程，ZeroMQ）
                 │              └─ RLM child runtimes（每個 child 一個 session ＋ 可選 kernel）
                 └─ Model providers ⇄ streams
```

- Worker 與 kernel 是**獨立進程**，目的是生命週期隔離與故障復原——文件明言「不是安全沙箱」。
- Daemon 讓 session 在終端離線後繼續跑（背景 agent、heartbeat、schedule、goal、autonomous mode 共用同一條 prompt 執行路徑）。

### 1.4 唯一內建工具：`ipython`

這是整個設計的支點。預設 session 裡**只有一個模型可見的內建工具**（`core/tools/index.ts:44-81` 的 registry 就是一個單一 entry 的 switch；`bash.ts`/`edit.ts` 原始碼存在但未註冊為內建）：

- **名稱** `ipython`，參數 schema 只有一個 `code: string`。
- **描述**（模型可見）："Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed…"
- **executionMode: "sequential"**——kernel 單執行緒，一次一個 cell。
- 讀檔、改檔、跑 shell（`%%bash` magic）、呼叫 skills、開 subagent、管理 context，全部是模型在 cell 裡寫 Python 完成。
- 模型看到的 tool result = `stdout + stderr + execute_result + traceback` 串接，**每一路各截斷在 65,536 字元**；圖片經 attachment MIME 變成 multimodal image block。
- Kernel 被迫重啟時，模型會收到 `<ipython_kernel_reset>` 通知，明說變數已失效需重建。

### 1.5 KernelManager：Jupyter/ZeroMQ 傳輸層

`core/kernel/index.ts`（1,529 行）自己實作了 Jupyter wire protocol 5.3：

- Spawn：`python -m ipykernel_launcher -f <connection.json>`，connection file 寫 5 個 port 為 0 讓 kernel 綁 ephemeral port 再回寫，HMAC-SHA256 簽章，127.0.0.1 TCP。
- 三個 channel：shell（execute_request/reply）、iopub（stdout/stderr/result/status/comm）、control（interrupt、shutdown、**host-request 回覆**）。
- `execute()` 以 promise chain 嚴格序列化；忙碌 kernel 的重用流程：每 500ms 送 interrupt、最多等 5 秒，仍忙則丟 `KernelBusyAfterInterruptError`，TUI 跳「等待保留狀態 / 殺掉重啟」選單。
- Linux 上有 **fork server** 加速路徑：template 進程預先 import `IPython/ipykernel/jupyter_client/nest_asyncio/rlm` 後 `gc.freeze()`，每次要新 kernel 就 `os.fork()`——冷啟動最佳化做得很深。
- 三個自訂 display MIME 承載 rich output：`…diff+json`（edit skill 的 diff 給 TUI 渲染）、`…attachment+json`（圖片進模型 context，上限 10MB base64）、`…agent-message+json`（cell 結束後的非同步 agent message 也能路由回來）。

**這一整層（ZMQ、Jupyter framing、HMAC、connection file、forkserver）都是「為了跟 ipykernel 講話」的成本**。換成自己控制的 runtime 後，這層可以縮到一個 JSON-lines 子進程協議。

### 1.6 Host bridge：`host.request` comm

Python 端要求 host 做事（開 subagent、發 agent message、查 goal、觸發 compact/refine…）的唯一通道：

1. Guest：`await rlm.host_request("rlm.run", {...})` 開一個 Jupyter comm（target `host.request`），payload 最後放 `type` 鍵防止被 payload 蓋掉。
2. Host：`KernelManager` 收到 comm_open → 依 `type` 分派到 `HostRequestHandlers` registry（`agent-session.ts:8662+` 註冊 `rlm.run`、`rlm.find_models`、`rlm.list_subagents`、`rlm.delete_subagent`、`model.info`，另按功能開關註冊 `goal.*`、`compact.*`、`refine.*`、`rlm_heartbeat.*`、`agent_message.*`、`agent_observe.*`、`mcp.*`）。
3. 回覆走 **control channel** 而非 shell——因為 IPython 序列處理 shell 訊息，在 cell 執行中用 shell 回覆會死結。Python 端還得把 comm handler 掛到 kernel 的 `control_handlers` 上、用 `loop.call_soon_threadsafe` 跨執行緒完成 future。

這是整個系統裡最細緻的 workaround。值得強調：**這個死結問題是 Jupyter 協議強加的複雜度**；在自建 runtime 裡，一個同步的 host function / RPC 呼叫天然沒有這個問題（見 §3.3）。host 端的 `HostRequestHandlers` registry 本身是語言中立的（收 JSON、回 JSON），**可原封不動重用**。

`rlm.run` 的語意：**admission-only**。呼叫立刻回 `RLMSpawnHandle{rlm_child_id, name, session_dir, model}`，絕不等待也絕不回傳 child 的答案；結果只透過 `agent_message` 回覆或檔案送達。child 是 host 建的完整 `AgentSession`（繼承模型/工具/深度限制，用量歸帳到 parent），registry 存活於 kernel 重啟與 compaction。

### 1.7 Kernel 環境 bootstrap 與 skills 安裝

- Venv：`uv python install 3.11` → `uv venv ~/.prime/agent/kernel-venv --seed` → `uv pip install ipykernel prime-agent-runtime dill requests httpx pyyaml tomli python-dotenv pandas numpy scipy beautifulsoup4 lxml pydantic tyro`。
- Bootstrap marker（schema 8）雜湊 runtime 原始碼與各 skill 的 `pyproject.toml`，不符就整個 venv 重建。
- **Python-backed skills** 以 `uv pip install --editable <skill-path>` 裝進 venv（拓撲排序、失敗僅警告），kernel 啟動時逐一 `importlib.import_module` 進 user namespace，並用 `ModuleType.__call__` 包裝讓 `await skill(...)` ≡ `await skill.run(...)`、把 `inspect.signature`/`__doc__` 抄到 module 上讓 `help(skill)` 可用。
- Kernel 啟動順序：dill 狀態還原 → rlm bootstrap（bootstrap 蓋掉還原出來的 `rlm`/skill handle，保證 handle 是活的）。

### 1.8 狀態持久化：兩個不同的問題、兩套機制

**（a）跨 compaction——什麼都不用做**。Compaction 只重寫 `agent.state.messages`；kernel 是獨立長命進程，繼續活著。系統做兩件輔助：summarization prompt 附註「kernel 還活著，把值得記的變數名寫進摘要」；compaction 後 host 探測 kernel namespace、注入 `<ipython_state>` 隱藏訊息列出仍存活的名稱。

**（b）跨 session resume——dill snapshot（best-effort）**。每次成功執行後 debounce 1.5s 觸發：對 user namespace 每個頂層名稱**獨立** `dill.dumps`（單一變數失敗只記錄、不中斷），跳過 `_` 開頭與 `{rlm, asyncio, In, Out, …}`，上限 256 MiB，原子寫入 `<artifacts>/kernel-state.dill` + `.json` manifest。resume 時逐一 `dill.loads`，模型收到 `<ipython_state_restored>` 列出還原成功與失敗的名稱。**開檔、socket、執行緒、不可 pickle 物件一律遺失。**

這個「best-effort、可能默默掉東西」的特性是 REPL-as-runtime 的固有稅。§2.2 會論證：Rust 顯式狀態層把「可序列化」從事後補救變成建構原則，這個問題整類消失。

### 1.9 System prompt：Python 教義有多深

Prompt 組裝（`system-prompt.ts:116-166`）：RLM base prompt → subagent 指引 → **Continual Harness State 區塊** → 工具貢獻的 guidelines → Project Context（AGENTS.md 全文內嵌）→ `<available_skills>` XML → append。固定本體約 **10–11 KB（~2,600–2,800 tokens）**，含 skills 與 harness 後約 15–20 KB。

核心教義 `IPYTHON_CONTROL_PROMPT`（4,157 字元）通篇是 Python 語言慣習，摘幾條說明耦合深度：

- "IPython is the agent's long-lived notebook … keep intermediate variables, inspect and transform outputs, write small helper functions, and preserve useful state across turns or compaction."
- `%%bash` 必須是 cell 第一行；`%cd`、`os.environ[...]`、`%env` 管 kernel 級狀態；`uv pip install <pkg>` 裝新套件。
- "Tool calls are themselves Python `await` expressions, so their return values can be bound to variables and composed into program logic."
- 連 `global_=True` 這個 API 都是因為 "Python reserves `global`"。
- 明確的雙環境紀律："Do not assume IPython is the native runtime of the external thing being investigated… run it through that project's own environment"——agent 的 scratchpad 與目標專案的環境是分開的。**這條紀律直接搬到 Rust 版：wasm 沙箱是 agent 的 scratchpad，目標專案指令照樣走專案自己的環境。**

結論：**prompt 層沒有「翻譯」這回事，Rust 版教義是重新創作**（§3.8）。

### 1.10 Skills 系統

三種 skill：

1. **Markdown skill**：`SKILL.md`（frontmatter：name ≤64 小寫-kebab、description ≤1024 必填否則默默不載入）——純指引。
2. **Python-backed skill**：SKILL.md + `pyproject.toml` + `src/<import_name>/__init__.py`，editable install 進 venv、預先 import 進 namespace，模型 `await skill(...)` 直接呼叫；另經 `tyro` 自動生成同名 CLI。
3. **Host-bridge skill**：Python 薄殼包 `rlm.host_request(...)`——`goal`、`agent_message`、`agent_observe`、`rlm_heartbeat`、`compact`、`refine` 都是這類（權威狀態在 TS host）。

發現路徑：全域（`~/.prime/agent/skills`、`~/.agents/skills`）、專案（`.prime/agent/skills`、`.agents/skills` 沿祖先到 git root）、package 附帶、settings、CLI `--skill`。Prompt 裡只放 metadata XML（name/type/python_import/description/location），全文按需讀取——標準 progressive disclosure。

13 個 bundled skills 中，真正「Python 實作」的只有 `edit`（exact-match 取代 + diff MIME）、`attach-image`（圖片壓縮進 context）、`websearch`（Serper API）；其餘不是 host-bridge 薄殼就是 markdown。**這對移植是好消息：skills 的重量級部分本來就在 host。**

### 1.11 Continual Harness 與 `/refine`

- 狀態檔 `harness_state.json`（schema 1）：四類 entry（`prompt` 補充註記/`memory`/`skill` 描述/`subagent` 規格），每筆有 id/title/content/path/scope/reference/arguments/metadata/version；`refinements[]` 記錄每次改進事件。local（session artifacts 下）與 global（`~/.prime/agent/harness/`）雙儲存，mtime 偵測跨進程同步（kernel 與 host 會同時讀寫）。
- `/refine`：獨立 LLM pass（trajectory 取末 80K 字元、maxTokens 32K、強制關 thinking），輸出嚴格 JSON 的 create/update/delete edits；apply 前重讀磁碟做樂觀併發檢查；每個 edit 存 before/after 快照支援反向回滾。**base system prompt 不可變**是硬規則（id `base_system_prompt` 直接拒絕）。
- Auto-refine：預設開，每 25 個 assistant turn 或 compaction 後觸發 review gate（僅 root depth、20 分鐘 cooldown），指示「寧可空 edits 也不要投機性記憶」。
- Harness 的 skill entry 硬性要求 `reference.type == "python"`（`harness.py:128-138` 與 `refinement.ts:684-703` 雙邊強制）——Rust 版需要把這個 discriminator 一般化（`"rust"`），是少數需要動 schema 的地方。

這一整層（schema、refine 協議、回滾、auto-refine 治理）**與執行語言無關，可全部沿用**。

### 1.12 可插拔性盤點：seam 與極限

正面清單比預期長。不 fork 就能做到的事：

1. **掛自訂 runtime tool**：extension `registerTool` 接受完整 `ToolDefinition`（含 `executionMode: "sequential"`、自訂 TUI 渲染、`promptGuidelines`），同名註冊**無條件覆蓋**內建工具（`agent-session.ts:8502-8505` 後寫者勝）；或 SDK 層 `AgentSessionConfig.baseToolsOverride`（註解明寫 *"useful for custom runtimes"*，走特殊分支完全不建構 `IpythonKernelProvisioner`）。
2. **關掉內建工具**：`--no-builtin-tools` CLI flag、或 runtime `pi.setActiveTools(names)`。
3. **覆蓋 system prompt**：`before_agent_start` hook 拿到完整的 `BuildSystemPromptOptions` 結構化輸入，可整段改寫——這是完整的 prompt 逃生門。
4. **Extension 可自帶 npm 依賴**（`with-deps` 範例，jiti 解析 extension 自己的 `node_modules`）；`sandbox` 範例更證明了「用不同執行後端整個換掉內建執行工具」是既有先例（它用 `@anthropic-ai/sandbox-runtime` 的 sandbox-exec/bubblewrap 包住 bash——注意：它只沙箱 bash，不碰 IPython kernel）。
5. **自訂 provider**：`pi.registerProvider`（含 OAuth 流程與 `streamSimple`）。

但有四個點是 extension 機制構造上到不了的，**這四點就是 fork 的理由**：

| 障礙 | 位置 | 後果 |
|---|---|---|
| Host bridge 是 IPython comm 專屬 | `hostHandlers` 只傳給 `IpythonKernelProvisioner`（`agent-session.ts:8558-8566`），extension 無任何等價 hook | 自訂 runtime 拿不到 `rlm.run`（遞迴 subagent）、`goal.*`、`agent_message.*`、`compact.*`、`refine.*`、`mcp.*` ——RLM 的核心能力全斷 |
| 兩行無條件 Python prompt | `prompts/rlm.ts:78-79`（"Pre-installed Python packages…"、"Install additional packages with `uv pip install`…"）不受 `hasIpython` gate 保護 | 即使停用 ipython，prompt 仍教 Python（只能 `before_agent_start` 全文覆蓋或 fork） |
| Goals 硬繫 ipython | `agent-session.ts:2040-2043` 字面丟出 "Goals require the ipython tool"；且 active goal 會**強制把 ipython 加回工具清單**（`:8610-8613`） | 長任務治理與自訂 runtime 互斥 |
| Skills 執行機制只有 Python 一種 | `SkillKind = "markdown" \| "python"`（`skills.ts:80`）、venv editable install | 非 Python runtime 失去全部可執行 skills 與 skill-creator 自我改進迴路 |

另外的摩擦（不致命但影響體驗）：renderer/ACP 按 `"ipython"` 字面分派（自訂工具退化為普通文字渲染）；`IpythonKernelProvisioner` 在非 `baseToolsOverride` 路徑下無條件建構（lazy、不會真的起 Python 進程，但佈線都在）；`<ipython_state>` 等 compaction/goal 通知、installer 的 venv 安裝流程、CLI 說明文字全是 Python 專屬。耦合總量：

| 類別 | 規模 | 內容 |
|---|---|---|
| 純 Python、fork 時整塊替換 | ~7.7K 行 TS + ~2.2K 行 Py + 965 行 skill Py + ~3.8K 行測試 | `core/kernel/`（KernelManager 1,529、bootstrap 929、forkserver 511、state-snapshot 297）、`tools/ipython.ts` 708、`prompts/rlm.ts` 199、`ipython-cell.ts` 渲染 712、`code-preview.ts` 443、`prime-agent-runtime`、11 個 Python skills |
| 部分耦合、外科手術式修改 | 散在大檔中共 ~6K 行 | `tools/index.ts`（**全 repo 最窄的咽喉點：2 行**——`ToolName = "ipython"`、`allToolNames`）、`system-prompt.ts`、`skills.ts`、`agent-session.ts`（85 處）、`refinement.ts`、`sdk.ts`、interactive/ACP 渲染分派、installer/CLI/env vars |
| 與 runtime 無關、原封重用 | **~90–92% 的 codebase** | `agent`（2.4K）、`ai`（34K）、`tui`（15K）全部；`coding-agent` 的 daemon/supervisor/worker、session JSONL 樹與 lease、cron/heartbeat、goals 核心、autonomous、compaction、extensions runtime、auth/OAuth、ACP/RPC/print 模式 |

**判定：不 fork 可以做出「能跑的 PoC」（extension 或 SDK 掛載、`--no-builtin-tools`、`before_agent_start` 覆蓋 prompt），但 host bridge、goals、skills、renderer 四座斷橋使產品化必須 fork。幸運的是耦合被隔離得異常乾淨——探索結論原話：「替換 cell executor 便宜；貴的是替換其上的 programming model」（prompt 教義、host bridge、skills 契約）。**

---

## 2. 核心命題：IPython+Python → WasmEdge+Rust 的語意對應

### 2.1 IPython 在此架構中真正提供的十件事

逐項拆解（這是「換 runtime」的需求規格）：

| # | IPython/Python 提供 | 在 prime-agent 中的角色 |
|---|---|---|
| 1 | 毫秒級動態求值 | cell 迭代迴路的節奏 |
| 2 | 持久 in-memory namespace | 「變數、import、helper 跨 turn/compaction 存活」的核心賣點 |
| 3 | dill 快照/還原 | 跨 session resume（best-effort） |
| 4 | 動態套件生態（`uv pip install` 任意包；預裝 pandas/numpy/scipy/bs4/…） | 研究型任務的資料處理能力 |
| 5 | `%%bash`（任意 shell）＋ `%cd`/`%env` | 對目標專案跑原生指令 |
| 6 | Jupyter comm host bridge | subagent/goal/message/mcp 等一切 host 能力 |
| 7 | Skill 載入（editable install + pre-import + `await skill(...)` + `help()`/`inspect` 內省） | 可執行技能與自我改進的載體 |
| 8 | Rich output（diff/image/agent-message MIME） | TUI 體驗與多模態 |
| 9 | 中斷/重啟治理（interrupt_request、busy-kernel 流程） | 長任務可控性 |
| 10 | `await` 作為 tool-call 原語 | 「工具呼叫是表達式、可組合」的 RLM 語意 |

### 2.2 對應表：每一項在 WasmEdge + Rust 的答案

| # | WasmEdge + Rust 對應 | 評價 |
|---|---|---|
| 1 | compile-run：熱編譯 **0.28s** + 執行 **10ms**（本機實測，§2.4）；rustc 診斷直接作為 tool result 回給模型 | **可接受**。LLM 推理延遲主導整個迴路；rustc 錯誤訊息品質對 LLM 修錯極友善 |
| 2 | **無直接等價**。替代三件套：持久 workspace crate（`agent_lib`，程式碼即記憶）＋ 顯式狀態層（serde → `/state` preopen 或 host KV）＋ 每 cell 是完整程式 | **根本轉換**（§2.3）。哲學從 state-as-objects 變 state-as-code+data |
| 3 | 免費獲得：狀態本來就在檔案，跨 session **100% 可靠**（vs dill 的 best-effort 掉東西） | **反超** |
| 4 | Cargo.toml 宣告 + 預選 prelude（serde/serde_json/regex/…須 wasm32-wasip1 相容）；`cargo add` 經 host 政策；共享 target dir 快取 | **受限**。資料科學生態明顯弱於 Python（§2.6） |
| 5 | 沙箱內無 shell（這是特性不是缺陷）。專案指令走 host 側 policied `bash` tool（原始碼已存在於 `tools/bash.ts`，啟用即可）或 `host.exec` host function | **需重新設計信任邊界**（§3.7）。與 prime-agent 的雙環境紀律一致 |
| 6 | Host functions（embedder 註冊）或 guest 經 WASI socket 連 host loopback JSON-RPC。**無 Jupyter shell/control 死結問題**；host 端 `HostRequestHandlers` registry 原封重用 | **反超**（更簡單、更可靠） |
| 7 | Skills as crates：SKILL.md + crate 掛進 workspace、`agent_lib` re-export；rustdoc/簽名作內省；**cargo test 成為技能品質閘** | **同級偏強**（型別化技能、可測試），但失去 REPL 內省的即時性 |
| 8 | Guest 呼叫 `rlm::diff()`/`rlm::attach_image()` → host function → 同樣的 MIME 事件流向 TUI | **同級**（機制平移） |
| 9 | 子進程 kill（CLI 模式）或 C API async cancel + gas metering（`SetCostLimit`）+ memory page limit + timeout | **反超**（決定性資源治理，ipython 只有盡力 interrupt） |
| 10 | 同步 host call 即可（admission-only 語意本來就不等待）：`rlm::spawn("task")? -> SpawnHandle`。Rust 的 `?`/`Result` 取代 `await` 慣習 | **同級**（語意保留，語法改變） |

### 2.3 根本差異：REPL vs compile-run，「cell = 程式」

必須誠實面對：**Rust 沒有可用的解譯器**。evcxr（Rust REPL）靠把每個 cell 編成 dylib 載入同進程、裸指標搬移變數——不支援 wasm target，且該機制本質上與沙箱目標矛盾。miri 慢到不可用。因此：

- **Cell 的單位是「完整可編譯程式」**（一個 `fn main()`），不是語句片段。模型每次輸出一個完整程式，host 寫進 `cell/src/main.rs`、編譯、在 WasmEdge 執行、回傳輸出。
- 兩個獨立編譯的 wasm module 無法共享 linear memory 佈局（Rust 假設自己擁有記憶體），所以「狀態留在記憶體、下個 cell 接著用」不成立。狀態必須顯式進檔案/host KV。
- 換個角度，這其實與 RLM 論文的精神**同構**：RLM 的主張是「context 放進變數、用程式操作」；Rust 版把「變數」實體化為 `/state` 裡的 serde 資料與 `agent_lib` 裡的函式。**程式碼本身變成第一級的長期記憶**——模型累積的不是易失的 in-memory 物件，而是型別檢查過、可測試、可重用的函式庫。這與 Continual Harness 的自我改進理念疊加得更好，不是更差。
- 對模型的實際負擔：不能再「戳一下看看」（`df.head()` 式探索）。每次探索都是一個小程式。緩解手段：cell 模板、`agent_lib` 預置高階 helper（`read_lines`、`grep`、`walk`、`json_query`…）、以及把常見探索模式做成一行呼叫。

### 2.4 實測數據（本機）

在報告撰寫過程中於本機完成的 micro-benchmark（一個典型 cell：讀 `/workspace` 目錄、統計檔案、serde_json 狀態檔讀改寫）：

| 項目 | 數值 | 條件 |
|---|---|---|
| 冷編譯（首次，含 serde+serde_json 依賴編譯） | **4.80s** | `cargo build --release --target wasm32-wasip1` |
| **熱編譯（改 main.rs 後增量）** | **0.28s** | 同上，target dir 已暖 |
| WasmEdge 執行（interpreter，含狀態檔 round-trip） | **0.01s** | `wasmedge --dir /workspace:<dir> cell.wasm` |
| 產物大小 | 206 KB | release、未 strip/wasm-opt |
| 狀態持久化 | ✅ | `state.json` 跨兩次執行正確累積（run #1 → run #2） |

環境：Apple Silicon macOS、rustc 1.97.0、WasmEdge 0.17.1（本機 build）。結論：**每 cell 端到端 ~0.3s**，佔 LLM 單輪延遲（5–60s）的 0.5–6%，在迭代迴路中不可感知。冷啟動 4.8s 僅發生在 session 首個 cell（且可用預建 target dir 消除）。AOT 對 cell 這種短命程式無必要（AOT 編譯本身比 interpreter 執行還久）；`agent_lib` 若長大可選擇性 AOT 快取。

### 2.5 反轉優勢：WasmEdge 版本能主張什麼

1. **真沙箱**。prime-agent 文件三處明言 kernel 不是沙箱、要求使用者自備隔離。WASI capability 模型讓「agent 的計算」deny-by-default：只 preopen `/workspace` 與 `/state`，無 ambient 網路/檔案系統/進程。這是從 0 到 1 的差異，不是改良。
2. **型別系統 = 免費 verifier**。Python cell 的錯誤在 runtime 才爆；Rust cell 的大類錯誤在 0.28s 的編譯就攔下，且 rustc 診斷（span、suggestion、error code）是結構化的修錯提示。對「agent 自己寫技能、自己迭代」的場景，`cargo test` + 型別檢查讓自我改進有品質閘——prime-agent 的 skill creator 沒有任何等價機制。
3. **決定性與可重放**。Wasm 執行決定性 + 全部 side effect 走可記錄的 host 邊界（preopen FS + host functions）⇒ trajectory 可完整重放。對 Prime Intellect 系（verifiers、PRIME-RL）與任何 RL 訓練場景，**這是把 agent 執行變成合法 RL environment 的性質**——Python kernel 永遠給不了。
4. **資源治理**。gas metering（cost limit）、memory page limit、async cancel、子進程 timeout：每個 cell 有硬預算。ipython 只有「盡力 interrupt、等 5 秒、不行就殺 kernel 丟狀態」。
5. **冷啟動與密度**。10ms 級 instance 啟動 + MB 級 footprint，天然適合 server-side 大規模並行 agent（對照 forkserver 為了 Python 冷啟動做的複雜工程）。
6. **生態一致性（Second State 視角）**：與 WasmEdge/LlamaEdge/WASI-NN 同堆疊——Phase 3 可讓同一個 runtime 跑本地 LLM 推理（llama.cpp backend），形成「模型與工具同沙箱」的完整故事。

### 2.6 劣勢與誠實的代價

1. **模型寫 Rust 的首次正確率低於 Python**——borrow checker、lifetime、型別簽名。預期每 cell 多 0–2 輪修錯迭代，token 成本上升（幅度需 Phase 0 實測；緩解：prelude、模板、教義、把 cell 寫成「膠水呼叫 agent_lib」的薄層）。
2. **資料科學/研究場景弱**。pandas/numpy/scipy/bs4 是 prime-agent 預裝清單，Python 在這裡無可替代。polars 有 wasm 故事但 wasm32-wasip1 下的完整度需驗證。定位建議：**先做 coding/systems agent，不對標 research agent**。
3. **Crate 生態的 wasi 相容性**。tokio 完整功能、native deps（openssl 等）、mmap 類 crate 在 wasm32-wasip1 不可用或需 feature 裁剪。需要維護一份「已驗證 prelude」。
4. **`%%bash` 的便利性消失**（見 §3.7——以顯式信任邊界換取）。
5. **無 REPL 內省**（`help()`、`dir()`、tab 補全語意）。以 rustdoc JSON / `agent_lib` 文件注入 prompt 替代。

---

## 3. 設計藍圖：wasmedge-agent runtime

本節描述與路線無關的核心設計（fork 或重寫都適用）。

### 3.1 架構總覽

```
（沿用）TUI / Print / JSON / RPC clients
（沿用）Daemon supervisor ─ Session worker（一棵 session tree 一進程）
（沿用）  └─ AgentSession：provider 呼叫、佇列、compaction、goals、
          │  child 生命週期、HostRequestHandlers registry（收/回 JSON，語言中立）
          │
（新）    ├─ RustCellManager（取代 KernelManager 的 3.3K 行 Jupyter/ZMQ 層）
          │    ├─ Workspace 管理（cargo workspace scaffold、cell 寫入、增量編譯）
          │    ├─ WasmEdge 執行（三種傳輸選項，見 §3.3）
          │    ├─ stdout/stderr 串流 → onStream →（沿用）TUI 即時渲染
          │    └─ 逾時 / gas / memory limit / cancel
          │
（沿用）  └─ providers（9 API × 32 provider）、sessions、skills 發現、harness
```

Guest 端以一個 `rlm` Rust crate 對應現在的 `prime-agent-runtime` Python 套件（同樣「thin shim、權威在 host」）：

```rust
// guest 端 rlm crate 的 API 面（對映現有 Python shim）
rlm::spawn(prompt) -> Result<SpawnHandle>          // = await rlm(...)，admission-only
rlm::find_models(query, limit) -> Result<Vec<Model>>
rlm::list_subagents() / rlm::delete_subagent(sel)
rlm::host_request(type, json) -> Result<Json>      // 泛用 bridge，型別字串同現制
rlm::msg::send(text, Role::Parent) / rlm::msg::list_agents()
rlm::goal::{get, create, complete}
rlm::state::{get::<T>(key), set(key, &T), keys()}  // serde KV → /state preopen
rlm::harness::*                                     // 直接讀寫 harness_state.json（沿用 schema v1）
rlm::{diff, attach_image}                           // rich output → 同樣的 MIME 事件
```

### 3.2 Cell 模型與持久 workspace（取代 in-memory namespace 的核心設計）

每個 session 的 artifacts 下維護一個 cargo workspace：

```
<session-artifacts>/<id>/workspace/
├── Cargo.toml          # [workspace] members = ["agent_lib", "cell"]；依賴鎖定＋vendored registry
├── agent_lib/          # ★ 持久函式庫：預置 prelude + skills re-export + 模型自建 helpers
│   └── src/lib.rs      #   「程式碼即長期記憶」——跨 turn/compaction/session 天然存活
├── cell/
│   └── src/main.rs     # ★ 每回合由 host 用模型給的 code 覆寫
├── state/              # ★ /state preopen：state.json、blobs——顯式狀態層
└── target/             # 共享增量編譯快取（warm 0.28s 的來源）
```

模型可見工具 `rust`（對映 `ipython`）：參數同樣只有 `code: string`，內容是一個完整的 `fn main()` 程式（慣例模板 `use agent_lib::prelude::*;` 開頭）。Host 流程：寫入 `cell/src/main.rs` → `cargo build --release --target wasm32-wasip1 --offline` → WasmEdge 執行（preopen `/workspace`=目標專案（可設唯讀）、`/state`、`/scratch`）→ 回傳 stdout/stderr/exit（沿用 65,536 字元截斷）。**編譯失敗時 rustc 診斷全文就是 tool result**——這是迭代迴路的一等公民，不是錯誤路徑。

三條慣例取代 IPython 的變數持久性：

1. **小資料走 `rlm::state`**：解析結果、計數、todo、中繼結論——serde 進 `/state/state.json`，跨 cell/session 100% 可靠（對照 dill 的 best-effort）。
2. **可重用邏輯進 `agent_lib`**：模型覺得某段邏輯會再用，就把函式寫進 `agent_lib/src/`（cell 裡直接寫檔即可），下個 cell `use` 得到，`cargo test -p agent_lib` 是自我改進的品質閘。這是 Continual Harness 的 skill 概念在語言層的自然延伸。
3. **大資料留在檔案**：與現行 prime-agent 教義一致（子 agent 用檔案交棒）。

Compaction 通知的對應物：現制是探測 kernel namespace 列出活變數；新制改為列出 `/state` 的 keys ＋ `agent_lib` 的 public API（host 掃 state.json + `cargo doc` 輸出）——資訊等價、實作更簡單。

### 3.3 Host bridge：三個傳輸選項

| 選項 | 機制 | 評價 |
|---|---|---|
| **T1：stock CLI + WASI socket** | spawn `wasmedge` 子進程；guest 的 `rlm` crate 經 wasi socket 連 host 的 loopback TCP（JSON-lines + per-session HMAC token） | 最快落地、零 FFI、與現行「spawn python 子進程」架構完全同構（把 ZMQ+Jupyter 換成 TCP+JSON-lines）。LlamaEdge 已證明 WasmEdge socket 路徑成熟。缺點：guest 網路能力無 per-destination 政策（與 ipython 現狀同級，仍優於它——FS 已被 preopen 限制） |
| **T2：薄 runner 內嵌 WasmEdge** | 一個小 Rust binary 用 C API/SDK 內嵌 WasmEdge，註冊真 host functions（`rlm_host_request(ptr,len)`、`rlm_emit(mime,payload)`），對 TS host 走 stdio JSON-RPC | 完整能力：gas metering（`SetCostLimit`）、memory page limit、async cancel、deny-by-default 網路（一切 I/O 過 host function 政策點）。建議的最終形態 |
| T3：WasmEdge plugin | host functions 做成 plugin 給 stock CLI 載入（`WASMEDGE_PLUGIN_PATH`），plugin 內連 host socket | 居中；適合想維持 stock CLI 又要 host functions 的部署 |

建議 **T1 起步、T2 定型**。特別注意：prime-agent 為了 Jupyter 的 shell-channel 死結被迫發明「comm 回覆走 control channel + `call_soon_threadsafe`」的深坑 workaround（`rlm-runtime.md` 有專節解釋）；T1/T2 的同步 request-response 天然無此問題，因為 `rlm.spawn` 的語意本來就是 admission-only 立即返回。**Host 端的 `HostRequestHandlers` registry 與全部 handler 實作（`rlm.run`、`goal.*`、`agent_message.*`、`mcp.*`…）原封不動重用——只換傳輸。**

### 3.4 Skills as crates

| 現制（Python） | 新制（Rust） |
|---|---|
| SKILL.md + `pyproject.toml` + `src/<name>/__init__.py` | SKILL.md + `Cargo.toml` + `src/lib.rs` |
| `uv pip install --editable` 進 venv | 掛為 workspace member ＋ `agent_lib` re-export（無安裝步驟，改碼即生效——重編譯 0.3s） |
| kernel 啟動時 pre-import、`await skill(...)` | `use agent_lib::skills::websearch;`，prompt XML 標注 `<rust_use>` |
| `help()`/`inspect.signature` 內省 | rustdoc（`cargo doc` / rustdoc JSON）注入 SKILL.md 或按需查詢 |
| 無品質閘 | **`cargo test` + 型別檢查**——skill-creator 產出的技能天生可驗證 |
| host-bridge skills（goal/agent_message/compact/refine/rlm_heartbeat/agent_observe）＝ Python 薄殼 | `rlm` crate 內建模組，**零個別安裝**（11 個 bundled Python skill 中 6 個直接消失於 crate 內） |
| `edit` skill（Python 實作 + diff MIME） | cell 內直接 `std::fs` 寫檔＋`rlm::diff()` 顯示；或沿用 host 側 edit tool |
| MCP 整合以 Python skill 呈現 | 同樣走 host bridge：`rlm::mcp::call(server, tool, json)` |

Harness 的 skill entry 需把硬編碼的 `reference.type == "python"`（`harness.py:128-138`、`refinement.ts:684-703` 雙邊強制）一般化為 `"rust"`——這是少數要動 schema 的地方，且向後相容（加值不改結構）。

### 3.5 沙箱與信任邊界（本方案的核心賣點，必須誠實劃線）

```
┌─ 信任邊界圖 ────────────────────────────────────────────────┐
│  Wasm 沙箱內（deny-by-default）                              │
│    agent 自身計算：讀寫 /workspace、/state、/scratch preopen │
│    T2 模式下連網路都必須過 host function 政策點               │
│  ───────────────────────────────────────────────────────────│
│  顯式越權通道（審計點、可掛 approval / OS sandbox）           │
│    bash tool（host 側）：對目標專案跑原生指令                 │
│    host bridge：spawn subagent、MCP、web search              │
│  ───────────────────────────────────────────────────────────│
│  Host（TS/daemon）：credentials、provider 呼叫、transcript    │
└─────────────────────────────────────────────────────────────┘
```

- `%%bash` 的對應：**啟用既有的 `tools/bash.ts`**（原始碼已在、只是未註冊為內建）。專案指令（`npm test`、`cargo build`）本來就必須在真環境跑——這與 prime-agent 教義「不要假設 scratchpad 是目標專案的 runtime」完全一致，現在只是把這條紀律變成架構事實。`sandbox` extension 範例（sandbox-exec/bubblewrap）可疊加在 bash 上。
- 必須避免 oversell：**沙箱涵蓋的是「agent 的自身計算」**；只要 bash tool 存在，整體系統就不是全沙箱。正確的主張是：把 prime-agent 裡「一切都在無沙箱 kernel 裡」收窄為「預設在沙箱、越權有名有姓可審計」。
- 決定性紅利：wasm 執行決定性 + host 邊界全部可記錄（host_request transcript + preopen FS 快照）⇒ trajectory 可重放、可驗證——對 RL 訓練（verifiers/PRIME-RL 一系）是質變。

### 3.6 Prompt 教義改寫要點（新寫，非翻譯）

`RUST_CONTROL_PROMPT` 需要教的核心概念（對照 `IPYTHON_CONTROL_PROMPT` 逐條重構）：

1. cell 是**完整程式**：`use agent_lib::prelude::*; fn main() -> Result<()>`，每次提交可編譯單元；編譯錯誤是正常回饋，直接修。
2. 持久性的三個層：`rlm::state`（小資料）、`agent_lib`（可重用邏輯——「想留下的能力寫成函式」）、檔案（大資料）。**變數不跨 cell**——這句要非常明確，是與 Python 版最大的心智模型差異。
3. 雙環境紀律（沿用原文精神）：wasm 沙箱是你的 scratchpad；目標專案的 import/test/CLI 走 `bash` tool 在專案自己的環境跑。
4. 工具呼叫是 `Result` 表達式：`let h = rlm::spawn("task")?;`——admission-only、結果經 message/檔案（語意與現制完全相同）。
5. 依賴紀律：prelude 已含 serde/serde_json/regex/…；新增 crate 需 `rlm::host_request("cargo.add", …)`（host 政策控管、檢查 wasm 相容白名單）。
6. Harness/refine 契約：同現制，把 `await <skill>(...)` 的 call form 換成 `agent_lib::skills::<name>` 的 use form。

一個此路線特有的**解放**：prime-agent 的 base RLM prompt 是「模型訓練過的前綴」（`system-prompt.ts:126` 註解 *"Appended AFTER the trained buildRlmPrompt prefix"*——Prime Intellect 有 RL 模型針對這個 Python runtime 微調）。我們面向通用 frontier models（Claude/GPT/開源模型），prompt 全新設計沒有相容包袱；反面是也拿不到他們微調模型的紅利（見 §6 風險 7）。

---

## 4. 路線選擇：Fork vs Extension vs 從頭打造

### 4.1 選項 A：Fork prime-agent、置換 runtime 層（建議主線）

**改動清單**（由 §1.12 耦合盤點直接導出）：

| 動作 | 對象 | 規模 |
|---|---|---|
| 刪除 | `core/kernel/`（ZMQ/Jupyter/forkserver/dill）、`prime-agent-runtime/`、11 個 Python skills、kernel 測試 | −7.7K TS、−2.2K Py、−965 Py、−3.8K 測試 |
| 新寫 | `core/rust-cell/`（RustCellManager：workspace scaffold、cargo runner、WasmEdge runner、T1 socket bridge、state 層）＋ guest `rlm` crate ＋ `tools/rust.ts` | 估 +3–5K TS、+1–2K Rust |
| 重寫 | `prompts/rlm.ts` → `prompts/rust-rlm.ts`（教義，內容工作）、`ipython-cell.ts` → rust-cell 渲染、`code-preview.ts` 的語言 regex | ~1.5K |
| 外科手術 | `tools/index.ts`（2 行咽喉點）、`system-prompt.ts`、`skills.ts`（+`SkillKind: "rust"`）、`agent-session.ts` 85 處、`refinement.ts`（reference.type）、goals 的工具名、sdk/index 匯出、ACP 對映、installer（venv → rustup target + wasmedge 檢查）、7 個 env vars、文件 | 散改 ~6K |
| 沿用 | 其餘 ~90%：ai/agent/tui 全部、daemon/worker/session/lease/cron/goals 核心/autonomous/compaction/extensions/auth | 0 |

**工作量估計**：單人全職——PoC 驗證後 4–8 週到 MVP（`rust` tool + bash tool + state 層 + prompt + 基本渲染），再 6–10 週到功能對齊（遞迴 subagent、agent_message、goal/heartbeat、harness/refine、skills-as-crates、installer/文件）。

**持續成本**：追上游。prime-agent 開發活躍（#658 級別的 fix 流量、7 天依賴冷卻、lockstep 版本），而它自己又追 pi-mono。緩解：改動集中在被刪除/替換的目錄（衝突面小）、外科手術點做成清單化的 patch set；或接受在某版本凍結分叉。

### 4.2 選項 B：Extension / SDK 掛載（不 fork）——降級為 PoC 載具

§1.12 已詳列：extension 能做到 tool 覆蓋、prompt 覆蓋、自帶依賴、甚至有 sandbox 範例當模板；但 host bridge（遞迴 subagent、goal、agent_message、MCP）構造上拿不到、goals 會強拉 ipython 回來、skills 契約是 Python 專屬。**作為產品會是一個「不會生小孩、沒有目標管理、沒有技能系統」的殘缺 RLM**。

正確用法：**Phase 0 的實驗載具**。一個 extension：`registerTool("rust", …)` 起 RustCellManager 雛形 + `--no-builtin-tools` + `before_agent_start` 換 prompt，在真實 prime-agent 環境（真 TUI、真 session、真 compaction）跑對照實驗，量測 §5 Phase 0 的指標。成本 1–2 週，零 fork 稅。

### 4.3 選項 C：從頭打造 Rust-native host

Host 也用 Rust 寫（內嵌 WasmEdge SDK），不背 TypeScript 棧。

- **得**：全 Rust 堆疊（Second State 品牌與工程文化一致）；與 LlamaEdge/WASI-NN 原生整合（同一 runtime 跑本地 LLM 推理與 agent 計算——「模型與工具同沙箱」的完整故事；GaiaNet 節點可直接成為 provider）；無 fork 同步稅；架構為 deterministic replay / RL environment 從第一天設計。
- **失**：§1.12 表裡那 ~90% 的沿用件全部要重建等價物。務實的 headless MVP（agent loop + 2–3 個 provider + session JSONL + rust-cell runtime + 無 TUI）估 3–6 人月；對齊 prime-agent 的 daemon/TUI/ACP/多 provider 成熟度是年級工程。Rust 生態有可借力的件（provider client crates、ratatui），但 34K 行 provider 層的細節（串流事件正規化、OAuth、cache 標記、各家怪癖）是被低估的大頭。
- **何時選它**：如果目標是「WasmEdge 生態的旗艦上游專案」而非「最快拿到可用的 Rust agent」；或 Phase 1 之後 fork 同步稅被證明不可接受時，帶著已驗證的 runtime 設計遷移。

### 4.4 決策矩陣與建議

| 維度 | A：Fork | B：Extension | C：從頭 |
|---|---|---|---|
| 到可用 MVP | **4–8 週** | 1–2 週（但天花板低） | 3–6 月 |
| 功能完整性（遞迴/goal/skills/TUI） | **全部** | 殘缺（四斷橋） | 逐步重建 |
| 維護成本 | 追上游（中） | 最低 | 自有（高但自主） |
| 沙箱/治理能力 | T1→T2 全拿 | T1 可拿 | 全拿＋最徹底 |
| Second State 戰略價值 | 中（TS 棧、他人品牌基因） | 低 | **高**（全 Rust、LlamaEdge、自有） |
| 風險 | 上游漂移 | 不是產品 | 工程量與範圍蔓延 |

**建議：B → A 為主線，C 為戰略備案。** 先花 1–2 週用 B 拿到「模型能不能用 cell=program 模式有效工作」的實證數據（這是全案最大的未知數，見 §6 風險 1）；數據成立即 fork（A）；C 只在明確要做旗艦開源專案、且願意付 3–6 人月前期成本時啟動——屆時 A/B 階段驗證過的 guest `rlm` crate、workspace 模型、prompt 教義全部可帶走，沉沒成本極低。

---

## 5. 分階段執行計畫

### Phase 0：PoC——回答「模型行不行」（1–2 週）

- 載具：選項 B（extension + `--no-builtin-tools` + `before_agent_start`），或更輕的 standalone harness。
- 建置：RustCellManager 雛形（T1 傳輸可先不做 host bridge，只做 cell 執行 + state 層）、workspace 模板、初版 `RUST_CONTROL_PROMPT`、benchmark 任務集（10–20 個代表性任務：檔案處理、重構、資料轉換、多步驟工具鏈）。
- **量測（exit criteria）**，與原版 ipython 對照：
  - 任務成功率；
  - 每任務 token 消耗與 cell 數（含編譯錯誤修復輪次——預期 Rust 多 0–2 輪/cell，需知道實際分佈）；
  - 每 cell 端到端延遲（驗證 0.3s 級在真迴路成立）；
  - 質性觀察：模型是否自發使用 state/agent_lib 慣例、還是每 cell 重算。
- 判準：成功率不低於 Python 版 15 個百分點以上、token 成本膨脹 < 2×，即值得 Phase 1。

### Phase 1：Fork MVP（4–8 週）

- Fork、刪 kernel 層、上 RustCellManager（T1 socket bridge 全量：host bridge 通、`rlm::spawn` 遞迴可用）、啟用 bash tool、`rust` tool 渲染（diff/串流）、prompt 定稿、state/compaction 通知、installer 改 rustup/wasmedge 檢查、vendored prelude registry。
- Exit：dogfood——用它開發它自己（吃自己狗糧是 coding agent 的天然驗收）。

### Phase 2：功能對齊（6–10 週）

- Skills-as-crates（發現/掛載/`SkillKind: "rust"`/skill-creator 改寫）、harness `reference.type: "rust"` + refine prompt 更新、goal/heartbeat/agent_observe/MCP host-bridge 模組、T2 runner（gas/page/cancel/deny-by-default 網路）、AOT 快取 agent_lib、跨 session 狀態驗收、Windows 支援評估。

### Phase 3：差異化（持續）

- **Deterministic replay**：host_request transcript + FS 快照 → 可重放 trajectory，對接 verifiers/RL 訓練管線。
- **LlamaEdge/WASI-NN**：本地模型 provider；長期做「推理與工具同 runtime」。
- **Component model**：skills 作為 component（跨語言 skills：Rust 之外接受任何能編到 wasm 的語言）；隨 WasmEdge CM 支援成熟推進（0.15 起 partial resources、0.16 nested component import isolation——先押 wasip1 core module，CM 是演進路徑不是依賴）。
- 伺服器端 agent farm（10ms 冷啟動 + MB 級 footprint 的密度優勢）。

---

## 6. 風險清單與開放問題

| # | 風險 | 影響 | 緩解 / 驗證 |
|---|---|---|---|
| 1 | **模型以 Rust 迭代的效率**（首錯率、borrow checker 迴圈、token 膨脹）——全案最大未知數 | 高 | Phase 0 專門量測；prelude/模板/教義降低 cell 難度；cell 定位為「呼叫 agent_lib 的膠水」而非復雜邏輯現場 |
| 2 | 資料科學/研究場景生態差距（pandas/numpy/scipy vs wasm 下的 polars/ndarray 完整度未驗證） | 中 | 定位先做 coding/systems agent；Phase 2 驗證 polars wasm32-wasip1 |
| 3 | Crate 生態 wasi 相容性（tokio 受限、native deps 不可用、mmap 類失效） | 中 | 維護已驗證 prelude 白名單 + vendored registry；`cargo.add` 過 host 政策 |
| 4 | Fork 追上游成本（prime-agent 活躍、其上還有 pi-mono） | 中 | 改動集中於整塊替換目錄；外科手術點 patch 清單化；必要時凍結版本 |
| 5 | 併發編譯資源（多 session/多 subagent 同時 cargo build；對照現制 forkserver 的苦工） | 低–中 | per-session target dir + 全域 registry cache；boot-gate 式編譯許可證（現成模式：`boot-gate.ts`） |
| 6 | 沙箱主張的誠實性（bash tool 在沙箱外） | 低（溝通風險） | §3.5 的邊界圖進文件與 README；bash 疊 OS sandbox（既有範例） |
| 7 | 失去 Prime Intellect 針對 Python RLM prompt 微調模型的紅利；通用模型對新教義的順從度未知 | 中 | 面向 frontier models 設計；Phase 0 用 2–3 家模型交叉驗證；長期可自行 RL（decisive replay 正好是訓練基建） |
| 8 | WasmEdge component model / wasip2 時程 | 低（設計上不依賴） | 主線押 wasm32-wasip1 core module；CM 僅 Phase 3 |
| 9 | T1 模式 guest 網路無細粒政策 | 低（過渡期） | 與現制 ipython 同級；T2 收斂為 deny-by-default |
| 10 | Windows（現制 kernel 流程本就有平台差異；wasmedge Windows 支援存在但 CI 面較薄） | 低 | Phase 2 評估；初期宣告 macOS/Linux |

**開放問題**（需要決策，不阻塞 Phase 0）：

1. 產品名與定位：wasmedge-agent 作為獨立專案 vs prime-agent 的 runtime 變體貢獻回上游（上游是否可能接受 runtime 抽象層 PR？`baseToolsOverride` 的存在暗示他們想過）。
2. cell 的語言範圍：純 Rust，或允許「任何編到 wasm32-wasip1 的語言」（設計上 RustCellManager 對語言中立，只差 toolchain driver 與 prompt）。
3. Phase 0 的模型選擇與預算。
4. 目標專案目錄的寫入權：`/workspace` 唯讀 + 顯式 apply（更安全、更適合 RL replay）vs 直接讀寫（更接近現制體驗）。

---

## 7. 附錄

### A. 關鍵檔案索引（prime-agent @ c22549a3）

| 主題 | 檔案 |
|---|---|
| Kernel 管理（ZMQ/Jupyter） | `packages/coding-agent/src/core/kernel/index.ts`（1,529 行） |
| Kernel venv bootstrap | `.../core/kernel/bootstrap.ts`（929）；`fork-server.ts`（363）＋`fork-server-script.ts`（148） |
| dill 快照 | `.../core/kernel/state-snapshot.ts`（297） |
| ipython 工具 + Python bootstrap 注入 | `.../core/tools/ipython.ts`（708；`RLM_BOOTSTRAP_BASE_CODE` 在 :24-141） |
| 工具 registry 咽喉點 | `.../core/tools/index.ts:46-47` |
| RLM prompt 教義 | `.../core/prompts/rlm.ts`（199；`IPYTHON_CONTROL_PROMPT` :14-34） |
| System prompt 組裝 | `.../core/system-prompt.ts:39-166` |
| Host request 驗證/分派 | `.../core/rlm-runtime.ts`（242）；註冊於 `agent-session.ts:8662-8674` |
| AgentSession（85 處 ipython 耦合） | `.../core/agent-session.ts`（11,188） |
| Skills 系統 | `.../core/skills.ts`（633）；`docs/skills.md` |
| Harness + /refine | `.../core/refinement/refinement.ts`（1,017）；`prime-agent-runtime/src/rlm/harness.py`（820） |
| Compaction | `.../core/compaction/compaction.ts`；`docs/compaction.md` |
| Extension API | `.../core/extensions/types.ts`（1,523）；`docs/extensions.md`（2,589） |
| Sandbox 範例 | `.../examples/extensions/sandbox/index.ts`（321） |
| Python guest shim | `prime-agent-runtime/src/rlm/__init__.py`（347） |
| Agent loop（100% 可重用） | `packages/agent/src/agent-loop.ts`（986）、`agent.ts`（613） |
| Provider 層（100% 可重用） | `packages/ai/src/providers/register-builtins.ts:327-379`（9 API）；`types.ts:19-51`（32 providers） |

### B. WasmEdge 事實依據（撰稿時點）

- 最新公開版本 **0.16.0**（2025-12-30）：component model 巢狀 import isolation 重構、memory64（interp/AOT/JIT）、`registerModule` alias、C API limit context。
- **0.15.0**：component model partial resource 支援與更多 interface types、GC proposal（interpreter + AOT）、WASI-NN 新 backend（mlx、llama.cpp vision/TTS、whisper.cpp、openvino-genai）、C API async invocation。
- 本機另有 master build 0.17.1 可用（本報告 benchmark 所用）。
- 對本設計的含義：**主線押 wasm32-wasip1 core module（穩定、Rust tier-2 target），component model 是 Phase 3 演進路徑而非依賴**；資源治理（statistics cost limit、memory page limit、async cancel）是長期穩定的 C API 能力。

### C. Benchmark 重現

```bash
cargo new cell-bench && cd cell-bench
cargo add serde --features derive && cargo add serde_json
# main.rs：讀 /workspace 目錄統計 + state.json 讀改寫（serde round-trip）
time cargo build --release --target wasm32-wasip1        # 冷 4.80s / 熱 0.28s
time wasmedge --dir /workspace:$PWD/ws \
  target/wasm32-wasip1/release/cell-bench.wasm            # 0.01s，state.json 跨執行累積
```

### D. 相關先行探索（本機過往工作）

- **WasmEdge Component Model 深入研究**（2026-03）：AST/loader/validator/executor 分層與 `ComponentImportManager` import isolation——支撐附錄 B 的判斷與 Phase 3 路徑。
- **agent-os**（2026-04 研究過的專案）：wasm32-wasip1（~130 crates）+ V8 + Pyodide 三 runtime 虛擬 OS、Rust kernel sidecar 集中執行 syscall 政策——「所有 side effect 過單一政策點」與本設計 T2 形態同構，是可參照的先行架構。

---

*報告完。建議的下一步：確認 Phase 0 的載具與模型預算後，先做 PoC 對照實驗再決定 fork。*
