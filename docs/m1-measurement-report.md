# M1 量測報告：PoC GO/NO-GO（DESIGN.md §6.3）

**日期**：2026-08-06（wave-1 + wave-2 同日完成）
**結論**：**GO——四個 B 條件全數通過 D20 閘，進入 Phase 1（fork）。**
B 組（rust/WasmEdge）pass rate **100%（73/73）**，高於 baseline（A 組 98.6%，唯一失敗是一次謊報完工）；token 成本 1.5–2.0× 落在閘內；「compile error 是一等回饋」的設計假說被強力驗證——sonnet 首 cell 編譯錯誤率高達 ~65%，但平均 1.3 個 cell 內收斂，最終全數通過。

## 1. 設定

- 任務：12 項 × 5 類別（DESIGN 附錄 C；fixture 決定性、check 離線）
- 矩陣：12 任務 × {A: ipython baseline, B: rust extension} × 3 reps × {claude-sonnet-4-6, claude-opus-5}（bytefuture gateway）
- B 組 D17 sub-A/B：r1/r3 = example、r2 = noexample（2:1，見 §5 註記）
- 有效 runs：**146**（wave-1 60 + wave-2 84 + 管線 smoke 2；04 任務 12 個因 driver `--resume` bug 作廢重跑，不計入）
- 量測中修復的 harness 問題（均為 driver 而非受測系統）：headless `--resume` 需明確 session 路徑；runId slug 消毒；analyze 遞迴掃描

## 2. 主結果與 D20 閘

| 條件 | runs | pass | tokOut(中位) | cells(中位) | compile-err 佔比 | cell p50 |
|---|---|---|---|---|---|---|
| opus-5 · A | 36 | 100% | 440 | 3 | 0% | 15ms |
| opus-5 · B/example | 24 | **100%** | 868 | 3 | 23% | 238ms |
| opus-5 · B/noexample | 12 | **100%** | 769 | 3 | 20% | 220ms |
| sonnet-4-6 · A | 37 | 97% | 773 | 4 | 0% | 13ms |
| sonnet-4-6 · B/example | 25 | **100%** | 1175 | 3 | 34% | 234ms |
| sonnet-4-6 · B/noexample | 12 | **100%** | 1518 | 5 | 35% | 221ms |

D20 閘（pass ≥ A−15pp 且 tokOut ≤ 2.0×A，需 ≥2 家模型）：

| B 條件 | pass | tokens | 判定 |
|---|---|---|---|
| opus · example | 100% vs 100% ✓ | 1.97× ✓ | **GO** |
| opus · noexample | 100% vs 100% ✓ | 1.75× ✓ | **GO** |
| sonnet · example | 100% vs 97% ✓ | 1.52× ✓ | **GO** |
| sonnet · noexample | 100% vs 97% ✓ | 1.96× ✓ | **GO** |

兩家模型同時達標 → **D20 GO 條件成立**。

## 3. 核心假說驗證：compile-run 迴路

REPORT §2.6 的最大未知數（風險 1）是「模型以 cell=program 模式寫 Rust 的迭代效率」。實測：

| 指標 | opus | sonnet |
|---|---|---|
| 首 cell 即編譯錯誤的 run 比例 | 17–33% | 64–67% |
| compile error 後至成功的平均 cell 數 | 1.14–1.20 | 1.32–1.45 |
| 未以成功 cell 收尾的錯誤串 | 0 | 4* |

\* 該 4 個 run 仍全數通過驗收——模型在錯誤 cell 後改以其他路徑（bash 或早前已完成的工作）收尾。

解讀：**首錯率高但無關緊要**。rustc 診斷品質讓收斂快（≤ DESIGN §6.3 的 ≤2 輪門檻）、每次重試僅 ~0.3s 編譯 + 數百 output tokens；sonnet 全部 73 個 B run 沒有一次因寫不出可用 Rust 而失敗。「編譯錯誤是正常回饋、不是失敗」的設計立場成立。

## 4. 其他觀察

- **持久層使用**：`rlm::state` 17%、`lib` 參數 8%——集中在狀態重用類任務（04/09），單回合任務不會自發使用。能力累積（agent_lib 長期成長）在短 bench 中不可觀測，屬 dogfood 期觀察項；prompt 對 lib 的推銷力度是 Phase 1 調校點。
- **多回合狀態重用成立**：04（兩回合）與 09（三回合能力累積）修復 driver 後兩組全過；B 組經 `rlm::state` 跨回合傳遞計數正確。
- **Baseline 的一次謊報完工**（08-rust-rename A/sonnet r2）：模型聲稱「rename 完成、cargo test 通過」但檔案未動，被 fixture check 抓到。n=1 不下結論，但正是「可驗證性」價值的具象案例——B 組的編譯/測試迴路結構上更難謊報。
- **延遲**：B cell p50 220–240ms（模板暖快取生效），牆鐘時間與 A 組同量級——REPORT §2.4 的「編譯延遲可忽略」在 146 run 規模成立。
- **D17（few-shot 範例）證據不定**：首錯率 example vs noexample 無差（sonnet 64/67%）甚至反向（opus 33/17%）；總 token sonnet 方向相反（example 較省）。n=12 過小。**決定：維持 example 為預設**（主力 sonnet 層總成本較低），Phase 1 以平衡 reps 重測後定案。

## 5. 已知侷限

1. Gateway 串流不回報 input tokens（兩組同偏差，對比有效；token 閘用 output）。cost 欄位同樣缺——本輪成本以牆鐘與 tokOut 估算（wave-1 ~75 分、wave-2 ~85 分、合計 ~93K output tokens 級）。
2. noexample 樣本 12/條件（split 2:1）；A 組混入 2 個 smoke run（同設定，無偏差方向）。
3. 單機（Apple Silicon）、單 gateway；開源權重模型組（D21 第三家）未跑——列 Phase 1 前置或並行補測。
4. 任務為合成 fixture（中小型）；真實中大型 repo 的表現由 Phase 1 dogfood 檢驗。

## 6. 決定與下一步

- **M1 gate：GO。** 依 DESIGN §12 進入 M2（fork 骨架 + cell 引擎，WP1–2）。
- 帶入 Phase 1 的調校清單：lib/state 的 prompt 推銷力度、sonnet 首錯率的教義優化（常見錯型：borrow/型別簽名——可在 prelude 文件加慣用式）、D17 平衡重測、開源模型組補測。
- 資料保存：`poc/bench/results/`（本機）、`bench.csv` 可重生（`node poc/bench/analyze.ts`）。
