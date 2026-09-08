# H3 生视频 P0/P1 修复状态（2026-09-07，09-08 更新）

> 分支：`fix/video-h3-p0-foundation-20260906`  
> PR：#13 `fix(video): close H3 P0 foundation gaps`  
> 目标文档：`docs/video/红潮_Hybrid_H3_A2A_生视频最佳实践与TODO.md`

## 1. 当前阶段结论

生视频链路已从“应用层集成原型”推进到“**有显式模型策略、真实 runtime gate、真实轻量 Loop QA、不可变资产血缘、单 GPU 崩溃恢复保护、统一 Comfy ownership、可操作 Reference Manager、Character Center no-copy reference adapter 与远端 Comfy reference transport 的候选实现**”。

当前不再存在已知的静态图/H3 共享 GPU 误释放、无归属全局 interrupt、Character Center reference 重复注册等代码 blocker。

仍不应标记 Production Ready，唯一无法在 GitHub CI 中替代的核心门是：

> 在目标 RTX 3060 12GB + 实际 ComfyUI 环境上，对 Ref2VA / FL2VA / experimental Hybrid 做真实 `/prompt` 生成与 A/B benchmark。

因此当前默认仍保持 experimental Hybrid；Official-Core Ref2VA / FL2VA 仅为 candidate。

本批次前最后完整绿灯基线为 CI #206；当前 head 继续由 PR checks 做最终确认。

---

## 2. 已完成并有 CI 覆盖

### H3 模型契约

- [x] 5 秒 H3 模型帧数改为 `17k+5` 对齐：124 model frames。
- [x] 产品交付仍标准化为 120f / 24fps / 5.0s。
- [x] Qwen3VL `CLIPLoader type=minimax`。
- [x] experimental Hybrid 与 Official-Core candidate 分离。
- [x] 新增 `minimax_h3_ref2va_official_12gb`。
- [x] 新增 `minimax_h3_fl2va_official_12gb`。
- [x] Ref2VA / FL2VA / Hybrid 通过 `workflow_id` 显式选择。
- [x] 策略不支持的输入直接拒绝，不再静默忽略。
- [x] VHS Load/Combine 输入字段按当前 VideoHelperSuite API 修正。

### A2A / Reference Context

- [x] `<Picture i>` / `<Video i>` reference role 编译。
- [x] Official Ref2VA：`<Picture 1>` 为 scene/keyframe，人物 identity 从 `<Picture 2>` 开始。
- [x] motion ref 明确只承担动作时序/姿态轨迹，不承担 identity。
- [x] reference asset 的 `character_id` 优先决定人物身份。
- [x] 多角色项目不再默认取数据库第一人。
- [x] `last_frame_asset_id` 已贯通 schema → preflight → staging → workflow。
- [x] 独立 `last_frame_reference` MediaAsset role，避免把尾帧伪装成普通 first/keyframe 资产。
- [x] reference upload 只接受 `image/*` / `video/*`，并按 role 强制媒体类型；PDF/任意 MIME 不再被误注册为图片。
- [x] Character Center `face/avatar/turnaround` 通过 no-copy adapter 注册/复用为 project-level `character_reference` MediaAsset；不迁移、不复制原图。
- [x] 同 URL 幂等复用；Character Center 换图时只 archive adapter 自己的 stale identity row。
- [x] canonical `/api/scenes/:scene_id/media` 同时返回 Scene assets 与 project-level character refs。
- [x] `scene_version=NULL` 的手工 First/Last/Character/Motion refs 在 versioned Scene 重载后保持可见。
- [x] 单角色 VideoSpec 不允许混入多个非空 `character_id`；mixed identity fail-closed。
- [x] identity gate 已下沉 `VideoGenerationService.preflight()`，未来内部 createTask 调用不能绕过 HTTP route。

### Runtime Gate

- [x] G0 feature flag 为硬门。
- [x] workflow-aware runtime inspector。
- [x] 检查 Comfy online。
- [x] 检查 workflow node / slot。
- [x] 检查 manifest 指定模型文件名。
- [x] 检查 ffmpeg / ffprobe。
- [x] `/preflight` 合并 service input blocker + runtime blocker。
- [x] `/generate` runtime 未就绪返回 503；service createTask 自身仍再次 preflight。

### GPU / 长任务 / 崩溃恢复

- [x] image/video 共用单 GPU lease。
- [x] video lease heartbeat。
- [x] queued lease 取消后 Promise 会 reject，不再永久悬挂。
- [x] 同 task 重复 acquire 不生成重复 queue slot。
- [x] `createTask()` 在返回 202 前预留 GPU slot，`queue_position` 对应真实提交位置。
- [x] H3 provider overall deadline：默认 30 分钟。
- [x] Comfy cancel scoped：pending 只 delete；仅 owned prompt 是唯一 running prompt 时才全局 interrupt。
- [x] cancel 网络请求独立有界；deadline 不再等待无限期 `/interrupt`。
- [x] image / H3 共用 `ComfyPromptOwnershipService` 安全 primitive。
- [x] Comfy prompt accepted 后绑定 GPU prompt guard；未确认停止时拒绝释放 lease。
- [x] image pipeline 显式保留真实 `lease_id`，不再依赖 blank release compatibility。
- [x] `releaseLease()` 只有 exact `lease_id + owner_task_id` 才有效；blank/stale/fake id 无法释放 active owner，也无法顺带取消 queued waiter。
- [x] queued cancellation 只有 `cancelQueuedTask()` 一个显式入口。
- [x] `cancelled` 为单调终态：queued rejection、pipeline catch、postprocess 完成都不能再覆盖成 `failed/completed`。
- [x] task terminal transition 通过 SQLite `WHERE status='processing'` 原子竞争，stale pre-check 不再覆盖先到终态。
- [x] 启动时先做 media-agnostic orphan Comfy prompt reconciliation：若旧 image/video prompt 仍活跃/所有权未知，先抢占 synthetic recovery lease，直到 prompt 被确认清除。
- [x] 通用 AssetTaskStore orphan cleanup 排除 video，避免提前把可从 `raw.mp4` / Comfy history 恢复的视频任务改成 `interrupted`。

### Remote Comfy / Reference Transport

- [x] 新增 `ComfyInputTransport`。
- [x] `stageAssetForComfy()` 支持 `auto / filesystem / http`。
- [x] 同机共享目录优先 filesystem；远端/无共享目录可 HTTP upload 到 Comfy input。
- [x] HTTP upload 使用 isolated `novastory` subfolder，带 timeout，失败 fail-closed。
- [x] NovaStory 本地 staging copy 保留，用于重现与审计。
- [x] 测试覆盖远端 upload 成功与 upload reject。

### Loop / QA

- [x] 移除 production synthetic `rawErrorScore ?? 1.2`。
- [x] 实测首尾 appearance difference。
- [x] 实测 boundary motion mismatch。
- [x] 实测 luminance/flicker discontinuity。
- [x] 分析不可用时进入 manual review，而不是伪造 pass。
- [x] 初始质量门：`<=1.50 pass / 1.50~2.20 manual_review / >2.20 reject`。
- [x] 8-frame boundary blend baseline。
- [x] 修复后重新 QA。
- [x] final 保持 exact 120f / 5.0s。

### Asset / Review State

- [x] 自动 QA pass 只生成 draft candidate。
- [x] manual review → `review_required`。
- [x] reject → `rejected`。
- [x] 只有人工 Promote 才成为 `ready` 正式成片。
- [x] rejected/archived 禁止 Promote。
- [x] reprocess 从 final 沿 `parent_asset_id` 找 raw。
- [x] 每次 reprocess 创建独立 `reprocess_*` derivative，不覆盖旧 final/poster/qa。
- [x] task API 返回 raw/poster/qa URL。

### Director / Reference Manager

- [x] 每个 Scene 视频卡提供 H3 Reference Manager。
- [x] First Frame：选择既有 `video_keyframe` 或直接上传。
- [x] Last Frame：独立选择/上传 `last_frame_reference`，并支持一键 K→K。
- [x] Character Ref：选择/上传 1..3 张人物参考图；Character Center refs 可直接复用。
- [x] Motion Ref：选择/上传动作参考视频。
- [x] Scene 内可显式选择 Hybrid / Official Ref2VA / Official FL2VA；最近策略写入本地偏好，批量任务继承该策略。
- [x] UI 主动隐藏不兼容输入：Ref2VA 不提交 hard last-frame；FL2VA 不提交 identity/motion refs；后端 schema/service preflight 仍作为最终硬门。
- [x] 当前 GPU queue position 在生成卡中可见。
- [x] 单任务取消调用真实 `/videos/tasks/:task_id/cancel`，不再只关闭 SSE。
- [x] batch stop 调用后端 cancel 当前 active H3 task；preflight/request-in-flight 两个竞态窗口均会阻止或立即取消新任务。
- [x] Stop 时保留 SSE/poll 直到收到 terminal cancellation，避免前端 Promise 因“关闭连接”而永久悬挂。

---

## 3. 目标机 A/B Benchmark

已增加：

```bash
npm --workspace backend run video:benchmark -- \
  --scene-id 123 \
  --keyframe 456 \
  --last-frame 457 \
  --char-refs 501,502 \
  --motion-ref 601 \
  --profile character_loop \
  --preset preview_480p_5s \
  --seeds 11,22,33 \
  --output ./h3-benchmark.json
```

默认比较：

```text
minimax_h3_hongchao_a2a_12gb
minimax_h3_ref2va_official_12gb
minimax_h3_fl2va_official_12gb
```

脚本会按策略自动裁剪不支持的输入：

- Hybrid：identity refs + motion + 可选 last frame。
- Ref2VA：scene/keyframe + identity refs + motion；不会假装支持 hard last-frame。
- FL2VA：first/last boundary；不会假装消费 identity/motion refs。

每个结果记录：

```text
workflow_id
seed
preflight_ready
status / stage
elapsed_seconds
seam_cost
normalized_score
quality_grade
output_url
task_id
error / blockers
```

同时输出 `.json` 与 `.csv`。

### 推荐验收矩阵

最少：

```text
3 个代表 Scene × 3 个 seeds × 3 个 strategy = 27 条视频
```

场景建议：

1. 静态半身人物微动态 / locked camera。
2. 明显身体动作 + motion reference。
3. 强首尾姿态约束 / K→K 或 K0→K1。

在没有这组数据前，不把任何 candidate 升为 stable/default。

---

## 4. 仍待完成

### P0 / 实机门

- [ ] RTX 3060 12GB 实机验证 Official-Core Ref2VA `/prompt`。
- [ ] RTX 3060 12GB 实机验证 Official-Core FL2VA `/prompt`。
- [ ] 运行 27 条最小 benchmark matrix。
- [ ] 根据成功率 / VRAM / 速度 / seam / identity 决定默认策略。

### P1 / 调度（未来条件项，不阻塞当前单进程）

- [x] `createTask()` 在返回 202 前完成 GPU queue reservation，使 `queue_position` 为真实提交位置。
- [ ] 仅当未来引入多进程/独立 worker 时，才把当前进程内 queue 持久化；单进程重启后的外部 Comfy GPU ownership 已由 startup reconciliation 保护。

### P2 / QA 增强

- [ ] DINO / face embedding identity drift。
- [ ] LPIPS/perceptual seam。
- [ ] optical flow velocity seam。
- [ ] calibration dataset 固化阈值。

---

## 5. Merge Gate

PR #13 当前保持 Draft。

建议满足以下条件后再考虑 Ready / Merge：

1. 当前 head CI 全绿。
2. 目标 Comfy 对三个 workflow 的 runtime preflight 输出已保存。
3. Ref2VA 与 FL2VA 至少各真实成功生成一条。
4. benchmark 最小矩阵已有结果，且没有发现 workflow JSON/API 结构错误。
5. experimental Hybrid 仍可作为实验对照，不因 candidate 引入破坏现有路径。

在实机门未完成前，代码可以继续合并工程修复，但不应把 Official candidate 标为 stable/default，也不应把 PR 从 Draft 提前标成 Production Ready。
