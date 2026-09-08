# H3 / main 功能重叠与冲突修复清单（2026-09-08）

> 目标：把 H3 分支视为 `main` 现有视频子系统的整体升级，而不是第二套并行视频系统；优先消除静态图（Pony / RedCraft Krea2 / SD1.5）与 H3 共用 ComfyUI / GPU 时的资源、取消、状态机冲突。

## 总结

- Git 关系：H3 分支完整包含当前 `main`，当前不存在需要“双向合并”的 main 新增提交。
- 产品功能：RedCraft/Krea2 静态生图与 H3 生视频是上下游关系，不是重复功能。
- 真正风险集中在共享基础设施：`GpuLeaseService`、ComfyUI prompt ownership/cancel、`generation_task` 生命周期、Director 批量停止。

## P0 — 合并前必须关闭

### P0-1 静态图 GPU lease 释放失效

**现象**

`GenerationService` 获取 `image` lease 后，`finally` 仍调用 `releaseLease('', taskId)`；H3 安全加固后空 lease id 被忽略，导致 RedCraft/Pony/SD1.5 完成后 GPU lease 最长残留到 image timeout，阻塞下一张图或 H3。

**目标**

- image prompt 与 lease 建立 ownership guard；
- 正常终止后确认 prompt 已离开 Comfy queue，再释放；
- 未确认 prompt 停止时绝不能提前开放 GPU；
- 兼容旧 image finally 的同时，后续收敛到显式 lease id。

**状态**：进行中

### P0-2 `/assets/cancel` 无归属全局 `/interrupt` 可误杀 H3

**现象**

旧 `ComfyUIService.cancelExecution()` 无论是否有 prompt id，最终都会 `POST /interrupt`。由于 `/interrupt` 是 ComfyUI 全局操作，静态图“停止”可能中断当前实际运行的 H3 prompt。

**目标**

- 无 `task_id` / `prompt_id` 时 fail-closed，禁止全局 interrupt；
- pending prompt 只做 `/queue delete`；
- running prompt 仅在“目标 prompt 是唯一 running prompt”时允许 `/interrupt`；
- 多 running / Comfy 状态不明时返回未确认，不释放 GPU ownership。

**状态**：进行中

### P0-3 静态图批量停止没有明确 task ownership

**现象**

Director 当前 `handleStopBatchGenerate()` 调用 `api.cancelAssetGeneration()`，没有显式传入当前 image task id。

**目标**

- 前端保留 active image task id；
- cancel 始终携带 task id；
- 兼容层不得把“无 task id”解释成“中断当前 Comfy graph”。

**状态**：待修

### P0-4 image terminal race 可覆盖 cancelled

**现象**

旧 `AssetTaskStore.processing/completed/failed/cancelled` 使用通用 UPSERT。取消与 worker 并发时，迟到的 processing/failed/completed 有机会覆盖 `cancelled`。

**目标**

- terminal transition 使用 CAS：只允许 `processing -> terminal`；
- `processing()` 不得复活 terminal row；
- progress 更新只写 progress 字段（已完成）；
- cancelled 后的迟到 worker 结果不得改变 canonical lifecycle。

**状态**：待修

### P0-5 image prompt 提交前取消缺少检查

**现象**

任务在等待 GPU / VRAM handoff / workflow compile 阶段被取消后，旧 image pipeline 仍可能继续 `/prompt`。

**目标**

- `/prompt` 提交前检查 canonical task 状态；
- queued lease cancellation 应让等待 worker 退出；
- cancelled task 不得创建新的 Comfy prompt。

**状态**：待修

## P1 — 建议在 H3 合入 main 前关闭

### P1-1 image 启动恢复没有 Comfy orphan ownership reconciliation

generic image restart recovery 会把 `processing` 标为 `interrupted`，但不像 H3 一样先确认 `comfy_prompt_id` 是否仍在 Comfy running/pending。NovaStory 重启而 Comfy 不重启时，存在旧 image prompt 仍占 GPU、应用却误认为 GPU 可用的窗口。

**建议**：把 H3 的 prompt reconciliation 下沉为共享 `ComfyPromptOwnershipService`，image/video 共用。

### P1-2 两套 Comfy client 语义漂移

- image：`ComfyUIService`
- video：`ComfyH3Provider`

两者分别实现 `/prompt`、WS、history、queue、cancel，已出现取消与 deadline 语义不一致。

**建议**：最终抽出共享 `ComfyExecutionClient`（网络/queue/history）+ `ComfyPromptOwnershipService`（guard/cancel/recovery）；image/video provider 只负责输出解析与 workflow 语义。

### P1-3 Character Center reference 与 Video MediaAsset reference 重复建模

静态图大量使用 `avatar_url / face_url / turnaround_url / character_ref_url`，H3 Reference Manager 使用 `MediaAsset ID + role`。功能不冲突，但同一参考图可能重复注册/上传。

**建议**：Character Center 资产注册进统一 MediaAsset catalog，或增加无复制 adapter。

## 已确认无需处理为“冲突”的部分

- RedCraft Krea2 与 H3 模型文件、VAE、workflow 不应按 Qwen 家族名去重；两者用途和权重不同。
- RedCraft/Pony/SD1.5 -> `video_keyframe` -> H3 是正确生产链路。
- H3 的 Hybrid A2A / Official Ref2VA / Official FL2VA 是视频策略扩展，不与静态模型矩阵重复。
- video 的 fail-closed、candidate/review/promote 生命周期应覆盖 main 旧视频行为，不保留两套语义。

## 验收门槛

1. image 完成后 lease 立即可交给下一 image/video task；
2. image stop 永远不会因为缺少 ownership 而全局 interrupt H3；
3. pending image cancel 不会提交 `/prompt`；
4. running image cancel 后，只有确认 prompt stopped 才释放 GPU；
5. cancelled 不会被迟到 progress/failed/completed/processing 复活；
6. 单元测试覆盖 pending / sole-running / multiple-running / no-owner cancel；
7. backend test + frontend/backend typecheck + production build 全绿；
8. RTX 3060 12GB 实机至少验证 RedCraft -> H3、H3 -> RedCraft、取消切换三个场景。
