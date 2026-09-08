# H3 / main 功能重叠与冲突修复清单（2026-09-08）

> 目标：把 H3 分支视为 `main` 现有视频子系统的整体升级，而不是第二套并行视频系统；优先消除静态图（Pony / RedCraft Krea2 / SD1.5）与 H3 共用 ComfyUI / GPU 时的资源、取消、状态机与资产身份冲突。

## 当前结论

- Git 关系：H3 分支完整包含当前 `main`，不存在需要“双向合并”的 main 新增提交。
- 产品功能：RedCraft/Krea2 静态生图与 H3 生视频是上下游关系，不是重复功能。
- P0 跨引擎安全问题已关闭。
- P1 启动恢复、Comfy ownership primitive、Character Center / MediaAsset reference 统一、image 显式 lease-id、Remote Comfy reference transport 均已关闭。
- 现在剩余的真正 release blocker 不再是代码内的 GPU 并发/误取消/资产重复，而是 **RTX 3060 12GB + 实际 ComfyUI 的实机 Gate 与 27 条 benchmark**。
- 本批次前最后完整绿灯基线：CI #206（frontend/backend typecheck、backend tests、production build 全部通过）；当前 head 继续由 PR checks 做最终确认。

## P0 — 合并前必须关闭

### P0-1 静态图 GPU lease 释放失效 — ✅ 已关闭并完成兼容清理

**原问题**

`GenerationService` 获取 `image` lease 后，legacy `finally` 调用 `releaseLease('', taskId)`；H3 加固后空 lease id 无法安全代表 ownership，可能造成 lease 残留或为了兼容而放宽释放权限。

**最终实现**

- `GenerationService` 显式保存 `GpuLeaseService.acquireLease()` 返回的真实 lease；
- `finally` 只使用 `gpuLease.lease_id + taskId` 释放；
- `GpuLeaseService.releaseLease()` 要求 **lease_id 与 owner_task_id 同时匹配**；
- blank / stale / fabricated lease id 一律无效；
- queued waiter 不再可通过伪 release 顺带移除，队列取消只有 `cancelQueuedTask()` 一个显式入口；
- prompt guard 存在时 exact release 仍会 deferred，直到 prompt 被确认离开 Comfy queue；
- 测试覆盖 image/video active owner、guarded prompt、fake id、blank id、queued handoff。

### P0-2 `/assets/cancel` 无归属全局 `/interrupt` 可误杀 H3 — ✅ 已关闭

**原问题**

旧 `ComfyUIService.cancelExecution()` 无论是否有 prompt id，最终都会 `POST /interrupt`。由于 `/interrupt` 是 ComfyUI 全局操作，静态图“停止”可能中断当前实际运行的 H3 prompt。

**已实现**

- 无 `task_id` / `prompt_id` 时直接 400，禁止 unscoped cancel；
- prompt-only cancel 必须解析到 canonical 非 video task，image endpoint 不能用 H3 prompt id 取消视频；
- pending prompt 只执行 `/queue { delete: [...] }`；
- running prompt 仅在目标 prompt 是唯一 running prompt 时允许 `/interrupt`；
- 多 running / queue 状态未知时 fail-closed；
- 只有确认 prompt 已停止才允许 task -> cancelled 与 GPU lease release；
- 测试覆盖 no-owner / pending / sole-running / multiple-running / already-absent / video prompt isolation。

### P0-3 静态图批量停止没有明确 task ownership — ✅ 已关闭（当前单 active image task 语义）

- `ApiService.generateAsset()` 保存最近成功创建的 `activeAssetTaskId`；
- `cancelAssetGeneration()` 优先使用显式参数，否则只允许使用自身已知的 active task id；
- 没有 owned task/prompt 时前端直接拒绝，不发送空 cancel；
- backend 仍做最终 ownership 校验，客户端缓存不是信任边界。

若未来允许多个 UI surface 并行发起静态图任务，再把 task id 下沉到各 surface/批次独立持有；当前 Director 串行链路不需要为未来并发预建第二套状态机。

### P0-4 image terminal race 可覆盖 cancelled — ✅ 已关闭

- terminal transition 使用 CAS：只允许 `processing -> terminal`；
- `processing()` 不再复活 terminal row；
- progress 只更新 progress 字段并刷新 canonical row；
- cancelled 后迟到的 processing / failed / completed 保持 canonical cancelled；
- queued cancel 先写 canonical cancelled，再 reject GPU waiter。

### P0-5 image prompt 提交前/提交中取消 race — ✅ 已关闭

- `/prompt` 前强制校验 active image lease + canonical processing task；
- pre-prompt cancel 不由 route 提前释放 active lease；
- 拿到真实 prompt id 后再次校验 ownership；
- `/prompt` flight-window cancel 会对刚获得的 prompt 做 scoped cancel；
- 停止未确认时保留 prompt guard/background watcher；
- image execution 有 bounded deadline，不以 API 已返回冒充 GPU 已空闲。

## P1 — 架构收敛

### P1-1 image / video 启动恢复统一 Comfy orphan ownership — ✅ 已关闭

- 启动扫描所有 `processing + comfy_prompt_id` 任务；
- image/video orphan prompt active 时先获取 synthetic `__comfy_orphan_recovery__` GPU lease；
- Comfy 不可达时 static image fail-closed；video 仅 `generating` 阶段视为 unresolved GPU ownership；
- recovery lease 直到 owned prompts 均被 scoped cancel 或 queue 证明 absent 才释放；
- inactive video prompt 保留给 raw/history 专用恢复。

### P1-2 两套 Comfy client 的 ownership/cancel primitive 重复 — ✅ 核心收敛完成

共享 `ComfyPromptOwnershipService` 统一负责：

1. bounded queue snapshot；
2. prompt active/absent 判断；
3. pending scoped delete；
4. sole-running `/interrupt` gate；
5. bounded stop confirmation；
6. GPU prompt guard stop confirmation；
7. worker ownership 丢失后的 background stop watcher。

`ComfyUIService` 与 `ComfyH3Provider` 只保留各自 workflow 提交、WS 解释、图片/视频产物解析，不再强行合成一个“大一统 Provider”。

### P1-3 Character Center reference 与 Video MediaAsset reference 重复建模 — ✅ 已关闭

**最终方案：no-copy identity adapter，而不是迁移/复制文件。**

- Character Center 原 `face_url / avatar_url / turnaround_url` 继续作为物理图片 canonical URL；
- `MediaAssetService.syncCharacterReferenceAssets(characterId)` 为这些现有 URL 建立/复用 project-level `character_reference` MediaAsset 身份；
- 同一 URL 幂等复用，不因多个 Character Center slot 重复建行；
- adapter metadata 标记 `source=character_center_adapter`、`no_copy=true`；
- Character Center 换图时只 archive adapter 自己的旧 identity row，不删除/复制原图；
- canonical `/api/scenes/:scene_id/media` 返回 Scene 资产 + project-level Character Center refs；
- `scene_version IS NULL` 的手工 First/Last/Character/Motion refs 在 versioned Scene 重载后仍可见；
- 旧 `/api/videos/scenes/:scene_id/media` 重复入口已删除。

### P1-4 单角色 H3 identity 不允许跨人物混选 — ✅ 已关闭并下沉 service

Project-level refs 跨 Scene 可见后，必须防止把人物 A 与人物 B 的参考图同时送进当前单角色 VideoSpec。

- `VideoReferenceIdentityService` 校验 role / project ownership / `character_id`；
- 1–3 张 refs 可以来自同一非空 `character_id`；
- `character_id=NULL` 的既有手工上传保持兼容，可与一个 bound identity 混用；
- 两个不同非空 `character_id` 同时出现时 fail-closed；
- identity gate 已从 Fastify route 下沉到 `VideoGenerationService.preflight()`；
- `createTask()` 内部调用也天然受同一 gate 保护，未来脚本/worker 不能绕过 HTTP route；
- route 只负责 schema、runtime 与 HTTP 状态组合，不再重复 identity DB 查询。

### P1-5 Remote Comfy reference transport — ✅ 已关闭

- 新增 `ComfyInputTransport`；
- `MediaAssetService.stageAssetForComfy()` 支持 `auto / filesystem / http`；
- 同机且共享 Comfy input 时继续优先 filesystem；
- 远端/无共享目录时可通过 Comfy `/upload/image` 上传 reference bytes；
- upload 有 timeout、isolated `novastory` subfolder、失败 fail-closed；
- 本地仍保留 NovaStory staging copy 作为可追溯证据；
- 已有测试覆盖远端 HTTP upload 与 rejected upload。

## 已确认无需处理为“冲突”的部分

- RedCraft Krea2 与 H3 模型文件、VAE、workflow 不应按 Qwen 家族名去重；两者用途和权重不同。
- RedCraft/Pony/SD1.5 -> `video_keyframe` -> H3 是正确生产链路。
- H3 的 Hybrid A2A / Official Ref2VA / Official FL2VA 是视频策略扩展，不与静态模型矩阵重复。
- video 的 fail-closed、candidate/review/promote 生命周期应覆盖 main 旧视频行为，不保留两套语义。

## 验收状态

| Gate | 状态 |
| --- | --- |
| image 正常结束可安全交接 lease 给下一 image/video | ✅ 自动测试覆盖；实机待验 |
| exact `lease_id + owner_task_id` capability release | ✅ |
| blank/fake release 不会释放 active owner 或取消 waiter | ✅ |
| image stop 不会因缺少 ownership 全局 interrupt H3 | ✅ |
| pending/pre-prompt image cancel 不提交新 prompt | ✅ |
| `/prompt` flight-window cancel 可 scoped 回收真实 prompt | ✅ |
| running image 只有确认 prompt stopped 才释放 GPU | ✅ |
| cancelled 不会被迟到 worker 状态复活 | ✅ |
| orphan image/video prompt 启动时阻塞新 GPU 工作直到清理 | ✅ |
| image/video 共用单一 Comfy ownership/cancel primitive | ✅ |
| Character Center refs no-copy / idempotent / stale archive | ✅ |
| Scene media 重载可见 NULL-version refs + project character refs | ✅ |
| mixed-character refs service-level fail-closed | ✅ |
| Remote Comfy reference HTTP transport | ✅ |
| backend tests | ✅ CI #206 基线；当前 head 由 PR checks 继续确认 |
| frontend/backend typecheck | ✅ CI #206 基线；当前 head 由 PR checks 继续确认 |
| production build | ✅ CI #206 基线；当前 head 由 PR checks 继续确认 |
| RTX 3060 12GB：RedCraft -> H3 | ⏳ 实机 Gate |
| RTX 3060 12GB：H3 -> RedCraft | ⏳ 实机 Gate |
| RTX 3060 12GB：运行中取消 / 重启恢复 / 连续切换 | ⏳ 实机 Gate |
| 3 Scene × 3 seed × 3 strategy benchmark | ⏳ 实机 Gate |

## 下一批次建议顺序

1. RTX 3060 12GB：至少让 Official Ref2VA 与 FL2VA 各真实成功 `/prompt` 一条；
2. 跑最小 27 条 benchmark matrix，记录 VRAM / latency / seam / identity / failure rate；
3. 根据真实结果决定 stable/default strategy；
4. 实机 Gate 全绿后再把 PR #13 从 Draft 推进到 merge-ready；
5. 后续增强项只保留：更强 perceptual QA（DINO/face embedding/LPIPS/optical flow）以及未来多进程时才需要的持久化 GPU queue。
