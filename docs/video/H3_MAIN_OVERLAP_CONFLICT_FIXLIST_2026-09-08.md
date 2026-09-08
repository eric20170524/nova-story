# H3 / main 功能重叠与冲突修复清单（2026-09-08）

> 目标：把 H3 分支视为 `main` 现有视频子系统的整体升级，而不是第二套并行视频系统；优先消除静态图（Pony / RedCraft Krea2 / SD1.5）与 H3 共用 ComfyUI / GPU 时的资源、取消、状态机冲突。

## 当前结论

- Git 关系：H3 分支完整包含当前 `main`，不存在需要“双向合并”的 main 新增提交。
- 产品功能：RedCraft/Krea2 静态生图与 H3 生视频是上下游关系，不是重复功能。
- P0 跨引擎安全问题已经关闭；P1-1 启动恢复和 P1-2 Comfy ownership primitive 收敛也已关闭。
- 当前剩余工作主要是资产模型统一（P1-3）、image lease 显式 ID 清理，以及 RTX 3060 12GB 实机 Gate；已知 GPU 并发 / 误取消 blocker 已关闭。
- 代码验证基线：CI #186，frontend/backend typecheck、backend tests、production build 全部通过。

## P0 — 合并前必须关闭

### P0-1 静态图 GPU lease 释放失效 — ✅ 已关闭

**原问题**

`GenerationService` 获取 `image` lease 后，legacy `finally` 仍调用 `releaseLease('', taskId)`；H3 安全加固后空 lease id 被忽略，导致 RedCraft/Pony/SD1.5 完成后 GPU lease 最长残留到 image timeout，阻塞下一张图或 H3。

**已实现**

- `GpuLeaseService` 对 blank release 做窄兼容：只有当前 `image` owner 可以使用，video blank hint 继续无效；
- image prompt 提交后建立 prompt guard；
- prompt 未确认停止时 release 被延迟；
- prompt 确认离开 Comfy queue 后才完成 deferred release；
- 非 owner / video 无法利用 blank id 抢占或释放当前 lease；
- 单测覆盖 current image owner、non-owner、guarded prompt、queued video handoff。

**后续清理**：`GenerationService` 最终应保留真实 `lease_id` 并显式释放，删除 blank-image compatibility path；这是代码收敛，不再是功能 blocker。

### P0-2 `/assets/cancel` 无归属全局 `/interrupt` 可误杀 H3 — ✅ 已关闭

**原问题**

旧 `ComfyUIService.cancelExecution()` 无论是否有 prompt id，最终都会 `POST /interrupt`。由于 `/interrupt` 是 ComfyUI 全局操作，静态图“停止”可能中断当前实际运行的 H3 prompt。

**已实现**

- 无 `task_id` / `prompt_id` 时直接 400，禁止 unscoped cancel；
- prompt-only cancel 必须能解析到 canonical 非 video task，image endpoint 不能用 H3 prompt id 取消视频；
- pending prompt 只执行 `/queue { delete: [...] }`；
- running prompt 仅在目标 prompt 是唯一 running prompt 时允许 `/interrupt`；
- 多 running / queue 状态未知时 fail-closed；
- 只有确认 prompt 已停止才允许 task -> cancelled 与 GPU lease release；
- 测试覆盖 no-owner / pending / sole-running / multiple-running / already-absent / video prompt isolation。

### P0-3 静态图批量停止没有明确 task ownership — ✅ 已关闭（兼容层方案）

**原问题**

Director `handleStopBatchGenerate()` 调用 `api.cancelAssetGeneration()`，没有显式传入当前 image task id。

**已实现**

- `ApiService.generateAsset()` 持有最近成功创建的 `activeAssetTaskId`；
- `cancelAssetGeneration()` 优先使用显式参数，否则只允许使用自身已知的 active task id；
- 没有 owned task/prompt 时前端直接拒绝，不再发送空 cancel；
- backend 仍做最终 ownership 校验，客户端缓存不是信任边界。

**后续清理**：若未来允许多个 UI surface 同时发起静态图生成，应把 task id 进一步下沉到各组件/批次显式持有，而不是依赖 API singleton 的单 active id。当前 Director 串行批量链路安全。

### P0-4 image terminal race 可覆盖 cancelled — ✅ 已关闭

**原问题**

旧 `AssetTaskStore.processing/completed/failed/cancelled` 使用通用 UPSERT。取消与 worker 并发时，迟到的 `processing/failed/completed` 可能覆盖 `cancelled`。

**已实现**

- terminal transition 改成 CAS：只允许 `processing -> terminal`；
- `processing()` 不再复活 terminal row；
- progress 只更新 progress 字段并刷新 canonical row；
- cancelled 后迟到的 processing / failed / completed 都保持 canonical cancelled；
- queued cancel 先写 canonical cancelled，再 reject GPU waiter，避免 worker 的 catch/failed 抢赢终态。

### P0-5 image prompt 提交前/提交中取消 race — ✅ 已关闭

**原问题**

任务在等待 GPU / VRAM handoff / workflow compile 阶段被取消后，旧 image pipeline 仍可能继续 `/prompt`；另有更窄窗口：取消发生在 `POST /prompt` 已发出但 `prompt_id` 尚未持久化时。

**已实现**

- `generateImage()` 在 `/prompt` 前强制校验：当前 lease 必须为 image、owner task 必须 canonical `processing`；
- pre-prompt active cancel 只写 cancelled，不由 route 提前释放 lease，由 worker unwind 负责释放，避免与正在飞行的 `/prompt` 重叠；
- 拿到真实 prompt id 后再次校验 GPU owner 与 canonical task；
- 若取消发生在 `/prompt` flight window，立即对新 prompt 做 scoped cancel；
- 停止未确认时保持 prompt guard / background watcher，GPU 不开放给下一 H3；
- image execution 增加 bounded deadline，deadline 后同样不以“API 返回”冒充 prompt 已停止。

## P1 — 合入 main 前的架构收敛

### P1-1 image 启动恢复没有 Comfy orphan ownership reconciliation — ✅ 已关闭

**原问题**

generic image restart recovery 会把 `processing` 标为 `interrupted`，但不像 H3 一样先确认 `comfy_prompt_id` 是否仍在 Comfy running/pending。NovaStory 重启而 Comfy 不重启时，旧 image prompt 可能仍占 GPU。

**已实现**

- 保留现有 `VideoStartupRecoveryService` 类名兼容调用，但 recovery 语义已改为 media-agnostic Comfy ownership reconciliation；
- 启动扫描所有 `processing + comfy_prompt_id` 任务，而不再只看 video；
- image/video orphan prompt 若仍 active，先获取共享 synthetic `__comfy_orphan_recovery__` GPU lease；
- Comfy 不可达时，静态 image prompt fail-closed；video 仅在 `generating` 阶段按 unresolved ownership 处理，避免把合法 postprocess 历史 prompt 当 GPU owner；
- recovery lease 直到所有 orphan prompt 均被 scoped cancel 或被 queue 证明 absent 才释放；
- inactive video prompt 仍留给 raw/history 专用恢复判断；
- 测试覆盖 active video、active image、Comfy offline image、inactive video history candidate。

### P1-2 两套 Comfy client 的 ownership/cancel 语义重复 — ✅ 核心收敛完成

**原问题**

- image：`ComfyUIService`
- video：`ComfyH3Provider`

二者曾各自实现 `/queue` 解析、prompt active 判断、pending delete、running interrupt、stop confirmation / watcher，存在安全语义再次漂移的风险。

**已实现**

新增最小共享 `ComfyPromptOwnershipService`，统一负责：

1. bounded queue snapshot；
2. prompt active/absent 判断；
3. pending prompt scoped delete；
4. sole-running global `/interrupt` gate；
5. bounded stop confirmation；
6. GPU prompt guard stop confirmation；
7. execution ownership 已丢失时的 opt-in background stop watcher。

`ComfyUIService` 与 `ComfyH3Provider` 均已删除上述重复 primitive，统一委托共享 service。

**刻意保留的差异**：

- image/video 的 `/prompt` 提交流程、workflow 语义不同；
- WS 事件解释和产物解析不同；
- image 输出图片，H3 输出视频/history 处理不同；
- 因此不继续强行合并成一个“大一统 Comfy Provider”，避免过度抽象。

**结论**：安全关键的 ownership/cancel primitive 已单源化；Provider 只保留媒体领域差异。

### P1-3 Character Center reference 与 Video MediaAsset reference 重复建模 — 🟡 待处理

静态图大量使用 `avatar_url / face_url / turnaround_url / character_ref_url`，H3 Reference Manager 使用 `MediaAsset ID + role`。功能不冲突，但同一参考图可能重复注册/上传。

**建议**：Character Center 资产注册进统一 MediaAsset catalog，或增加无复制 adapter；优先统一“身份/role/ownership”，不要迁移或复制物理文件。

## 已确认无需处理为“冲突”的部分

- RedCraft Krea2 与 H3 模型文件、VAE、workflow 不应按 Qwen 家族名去重；两者用途和权重不同。
- RedCraft/Pony/SD1.5 -> `video_keyframe` -> H3 是正确生产链路。
- H3 的 Hybrid A2A / Official Ref2VA / Official FL2VA 是视频策略扩展，不与静态模型矩阵重复。
- video 的 fail-closed、candidate/review/promote 生命周期应覆盖 main 旧视频行为，不保留两套语义。

## 验收状态

| Gate | 状态 |
| --- | --- |
| image 正常结束可安全交接 lease 给下一 image/video | ✅ 自动测试已覆盖 ownership/release；实机待验 |
| image stop 不会因缺少 ownership 全局 interrupt H3 | ✅ |
| pending/pre-prompt image cancel 不提交新 prompt | ✅ |
| `/prompt` flight-window cancel 可 scoped 回收真实 prompt | ✅ |
| running image 只有确认 prompt stopped 才释放 GPU | ✅ |
| cancelled 不会被迟到 worker 状态复活 | ✅ |
| orphan image/video prompt 启动时阻塞新 GPU 工作直到清理 | ✅ |
| image/video 共用单一 Comfy ownership/cancel primitive | ✅ |
| no-owner / pending / sole-running / multiple-running cancel tests | ✅ |
| backend tests | ✅ CI #186 |
| frontend/backend typecheck | ✅ CI #186 |
| production build | ✅ CI #186 |
| RTX 3060 12GB：RedCraft -> H3 | ⏳ 实机 Gate |
| RTX 3060 12GB：H3 -> RedCraft | ⏳ 实机 Gate |
| RTX 3060 12GB：运行中取消 / 重启恢复 / 连续切换 | ⏳ 实机 Gate |

## 下一批次建议顺序

1. **P1-3**：Reference Manager 与 Character Center 做 MediaAsset adapter，避免参考图重复注册/上传；
2. 清理 legacy `releaseLease('', taskId)`，让 image pipeline 显式持有真实 lease id，并删除 blank-image compatibility path；
3. RTX 3060 12GB 三组实机 Gate；
4. Gate 全绿后把 PR #13 从 Draft 推进到 merge-ready。
