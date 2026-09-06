# 红潮 Hybrid / MiniMax H3 / A2A 生视频：实际实现评审、最佳实践与 TODO

> 评审对象：`eric20170524/nova-story`
>
> 评审分支：`main`
>
> 评审基线：`76826b0414c7b179b3977d641e8080487ee38aa3`（2026-09-06 21:43 +08:00，`继续优化生视频功能`）
>
> 前一关键提交：`8d3c5c733dae1d87bf88c0f134a54d86bc3a7fab`（2026-09-06 19:04 +08:00，`合入生视频功能`）
>
> 评审原则：按仓库 `AGENTS.md` 要求，以**当前代码实际行为**为准，不以规划文档中的“完成/未完成”作为事实；采用“基线 → 静态检查 → 测试覆盖 → 验收矩阵”的方式核验。

---

## 0. 结论先行

### 0.1 总体判断

当前生视频能力**不是空壳**。后端 API、任务持久化、MediaAsset、GPU 串行租约、ComfyUI Provider、H3 workflow compiler、后处理、恢复、前端 Director UI、SSE/polling、候选资产等已经形成了一条真实的端到端工程链路。

但它也**还不能定义为“红潮 Hybrid H3 A2A 最佳实践已完成”**。

更准确的阶段是：

> **Integrated Alpha / 可运行原型级集成，尚未达到 H3 工作流正确性 + Hybrid 语义正确性 + Loop QA 可验收的 Production Gate。**

主要原因不是“代码量不够”，而是目前最核心的三个质量约束仍然没有真正闭环：

1. **H3 基线工作流与官方 Comfy-Org Ref2VA 模板存在关键语义差异**；
2. **显式 Last Frame 虽进入 schema/manifest，却没有进入实际 runtime staging，当前实际仍是 K→K fallback**；
3. **Loop QA 的 continuity 分数是模拟值，LoopCloser 也只是固定 FFmpeg crossfade，并非测量驱动的闭环优化。**

所以当前最需要做的不是继续增加 UI、参数或更多 profile，而是**先收敛模型基线与质量门**。

---

## 0.2 成熟度拆分

| 子系统 | 实际成熟度 | 判断 |
|---|---:|---|
| API / DB / MediaAsset 基础设施 | 高 | 已形成真实链路 |
| H3 Provider / Comfy 提交与回收 | 中高 | 基础完善，但超时、远程 staging、取消语义仍需收敛 |
| Hybrid 输入模型 | 中 | 首帧/角色图/motion 已接；显式尾帧断链 |
| A2A / Ref2VA 模型语义 | 中低 | JSON 已连接多参考，但未对齐官方 H3 Ref2VA 基线与 reference tagging |
| H3 workflow 可部署性 | 中低 | 权重是真实的，但 workflow 关键节点/loader/sampler 与官方模板不一致 |
| LoopCloser | 低到中 | 有后处理，但不是质量驱动闭环 |
| QA / 自动验收 | 低 | continuity 指标目前是 synthetic |
| GPU 调度 | 中高 | 已共享 image/video lease，但 heartbeat/持久队列仍有缺口 |
| 恢复机制 | 中 | raw/history 可恢复，其他阶段降级 interrupted |
| Director 前端集成 | 中高 | UI 已接，但有若干跨层错配 |
| 自动化测试 | 中 | 覆盖 API/schema/compiler，但缺 H3 实机、跨层和真实视频 QA |
| Production Readiness | **暂不通过** | 建议保持 G0 默认关闭 |

---

# 1. 当前实际架构

当前实际链路可以概括为：

```text
Director UI
  │
  ├─ 生成/注册 16:9 keyframe
  ├─ 选择 profile/preset
  ├─ scene MediaAsset 中寻找：
  │    ├─ video_keyframe
  │    ├─ character_reference × 0~3
  │    └─ motion_reference × 0~1
  │
  ▼
POST /api/videos/preflight
  │
  ▼
VideoSpecCompiler
  │
  ├─ subject_identity
  ├─ primary_action
  ├─ temporal_arc
  ├─ positive / negative prompt
  └─ 864x480 or 1280x720 / 121f / 24fps
  │
  ▼
POST /api/videos/generate
  │
  ├─ generation_task 持久化
  ├─ GpuLeaseService.acquireLease(video)
  ├─ 释放 Ollama + Comfy cache
  ├─ stage keyframe / character refs / motion ref
  │
  ▼
VideoWorkflowCompiler
  │
  ▼
minimax_h3_hongchao_a2a_12gb.api.json
  │
  ▼
ComfyH3Provider
  │
  ├─ WebSocket progress
  ├─ POST /prompt
  ├─ /history fallback
  └─ 下载第一个视频产物
  │
  ▼
raw.mp4 + raw_video MediaAsset
  │
  ├─ 提前 release GPU lease
  ▼
LoopCloser
  │
  ├─ ffmpeg 标准化
  ├─ character_loop: fixed 0.5s crossfade
  ├─ poster
  └─ LoopAnalyzer
  │
  ▼
final.mp4 / poster.jpg / qa.json / manifest.json
  │
  ▼
loop_master / narrative_final MediaAsset
  │
  ▼
Director SceneVideoPlayer
```

这条链路的最大优点是：**业务层、资产层、GPU 层、模型层、后处理层已经解耦**。后续不需要推倒重来，应该做“模型基线纠正 + 关键接口补齐 + QA 真实性替换”。

---

# 2. 已经真正实现的部分

## 2.1 视频专用数据模型已经成立

`backend/src/db/database.ts` migration `012_video_generation` 已增加：

- `media_asset`
- `project_id / scene_id / scene_version / character_id`
- `parent_asset_id`
- `media_type / role / profile / status`
- 视频 `width / height / fps / frame_count / duration_ms`
- `sha256 / metadata_json`
- `generation_task.kind / stage / output_url / request_json / metadata_json`
- heartbeat / started / completed 时间字段

且 `comfy_prompt_id` 早在 migration 006 已存在。

这是正确方向：视频不是覆盖 `scene.asset_url`，而是作为可追溯 derivative asset 进入资产图。

**评价：通过。**

---

## 2.2 API surface 已较完整

`backend/src/routes/videos.ts` 已包含：

- `GET /api/videos/capabilities`
- `POST /api/videos/preflight`
- `POST /api/videos/references/upload`
- `POST /api/videos/assets/register`
- `POST /api/videos/generate`
- `GET /api/videos/tasks/:task_id`
- `GET /api/videos/tasks/:task_id/stream`
- `POST /api/videos/tasks/:task_id/cancel`
- `GET /api/videos/scenes/:scene_id/media`（注册前缀后）
- `POST /api/videos/assets/:asset_id/promote`
- `POST /api/videos/assets/:asset_id/reprocess`

服务也已经在 `backend/src/server.ts` 注册，并在启动时做视频任务 recovery。

**评价：通过。**

---

## 2.3 H3 workflow 已从代码中分离

目前采用：

- `backend/static/video-workflows/minimax_h3_hongchao_a2a_12gb.api.json`
- `backend/static/video-workflows/minimax_h3_hongchao_a2a_12gb.manifest.json`

由 `VideoWorkflowCompiler` 注入动态 slot。

这一点非常好，后续可以直接增加：

```text
h3_ref2va_official_12gb
h3_fl2va_official_12gb
h3_hybrid_experimental
```

而无需把模型差异继续堆进业务代码。

**评价：通过，建议保留此抽象。**

---

## 2.4 权重名称并非占位

当前 manifest 中的关键权重：

- `minimax_h3_ref2va_pruned_int8_convrot.safetensors`
- `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
- `minimax_h3_video_vae_fp16.safetensors`

都能在当前 Comfy-Org MiniMax-H3 模型仓库中找到。

也就是说，模型文件命名方向是有真实公开基线的。

但注意：manifest 中所谓 `model_fingerprints` 目前不是实际 64 位 SHA-256，而是类似：

```text
sha256:ref2va_int8_convrot_verified
```

这种逻辑标签。

因此当前只能说“文件名真实”，不能说“运行时已验证模型 fingerprint”。

---

## 2.5 GPU 串行化已经覆盖 image + video

`GpuLeaseService` 并不是视频自己的一套锁。

现有图片 `GenerationService` 也会：

```ts
GpuLeaseService.acquireLease(taskId, 'image')
```

视频会：

```ts
GpuLeaseService.acquireLease(taskId, 'video')
```

因此在单进程模式下，图片和视频已经共用 Max-1 GPU critical section。

这比“视频自己排队、图片仍可同时打爆显存”要成熟得多。

**评价：基本通过。**

---

## 2.6 raw/final 分层和提前释放 GPU 是正确的

视频 pipeline 在拿到 raw Comfy 输出后：

1. 写入 `raw.mp4`
2. 创建 `raw_video`
3. **先 release GPU lease**
4. 再用 CPU/FFmpeg 做 postprocess

这是非常正确的吞吐策略。

**评价：通过。**

---

## 2.7 崩溃恢复不是空实现

`recoverTasksOnStartup()` 已覆盖：

- raw 已落盘 → 从 postprocess 恢复
- generating + `comfy_prompt_id` + Comfy history 有输出 → 从 collecting 恢复
- 无法恢复 → 标记 `interrupted`

这是有实际价值的持久化恢复，而非只把所有 processing 都重置为 failed。

**评价：部分通过。**

---

# 3. P0：必须先修的阻断问题

## P0-1. 当前 H3 workflow 未对齐官方 Ref2VA baseline

### 当前实现

仓库 `minimax_h3_hongchao_a2a_12gb.api.json` 采用：

- `H3Ref2VAAdapter`
- `CLIPLoader`：
  - `clip_name = qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
  - **type = `sd3`**
- 普通 `KSampler`
- `sampler_name = euler`
- `scheduler = normal`
- 6 / 10 steps
- 自定义 `EmptyLatentVideo`
- 121 frames

### 当前官方 Comfy-Org Ref2VA 模板

当前官方 `video_minimax_h3_r2v.json` 使用的主路径是：

- `MiniMaxH3ReferenceToVideo`
- `CLIPLoader type = minimax`
- `KSamplerSelect = res_multistep`
- `BasicScheduler`
- `BasicGuider`
- `SamplerCustomAdvanced`
- Ref2VA 专用 diffusion model
- prompt 与 reference tag 绑定
- 5 秒长度由 H3 frame alignment 公式换算

因此当前 NovaStory workflow **不是官方模板的轻量改写，而是另一套自定义执行图**。

### 最高风险点

#### 1. `CLIPLoader type=sd3` 明确不一致

官方当前模板是：

```text
qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
type = minimax
```

当前仓库是：

```text
qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
type = sd3
```

这是首先要修的点。

#### 2. sampler 语义不一致

当前：

```text
KSampler + euler + normal
```

官方 Ref2VA：

```text
res_multistep
+ BasicScheduler
+ SamplerCustomAdvanced
```

在没有 A/B benchmark 证明自定义采样更好的情况下，不应把当前配置命名为“最佳实践”。

#### 3. 自定义 `H3Ref2VAAdapter` 需要来源验证

当前公开官方模板使用 `MiniMaxH3ReferenceToVideo`。

本次外部核验没有找到 `H3Ref2VAAdapter` 作为官方当前主路径。

这不等于该节点一定不存在，但意味着：

> 它必须被当成**实验性/第三方 dependency**管理，而不是默认认为等价于官方 H3 Ref2VA。

### 建议

立即建立三个 workflow id：

```text
minimax_h3_ref2va_official
minimax_h3_fl2va_official
minimax_h3_hybrid_experimental
```

先以 official baseline 作为 Production Candidate，再把当前自定义 Hybrid 留在 experimental profile。

---

## P0-2. H3 5 秒 frame contract 与官方 alignment 不一致

当前 `VideoSpecCompiler`：

```text
frames = 121
fps = 24
```

而当前官方 Ref2VA 模板对 duration 使用：

```text
max(5, round(seconds * 24))
+ (5 - (frames % 17)) % 17
```

5 秒：

```text
round(5 * 24) = 120
120 % 17 = 1
=> 120 + 4 = 124
```

也就是官方 R2V baseline 的 5 秒 generation length 是 **124**。

当前 `121 % 17 = 2`，并不满足该 alignment。

### 建议

把“生成 latent length”和“产品交付帧数”拆开：

```text
H3 generation contract:
  duration = 5s
  model_frames = 124  // follow H3 alignment

Delivery contract:
  fps = 24
  duration = 5.0s
  final_frames = 120
```

不要为了最终 120f，直接把 H3 模型输入硬设为 121f。

---

## P0-3. 显式 Last Frame 实际被完全忽略

这是当前最明确的跨层 bug。

### schema 层

`VideoGenerationRequestSchema` 有：

```ts
last_frame_asset_id
```

### workflow compiler 层

也支持：

```ts
lastFrameFilename
```

并会：

```ts
lastFrameFilename || firstFrameFilename
```

### 但 pipeline 层

`runTaskPipeline()` 只 staging：

- keyframe
- character refs
- motion ref

没有读取：

```ts
request.last_frame_asset_id
```

也没有：

```ts
MediaAssetService.stageAssetForComfy(lastFrameAsset)
```

最终调用 compiler 时也没传：

```ts
lastFrameFilename
```

所以：

> **当前所有 Last Frame 实际都回退成 First Frame。**

### 前端也没有入口

`DirectorMode.handleGenerateVideo()` 的 options/request 也没有 `lastFrameAssetId`。

### 实际状态

当前“首尾帧 A2A”不是：

```text
K0 → K1
```

而是始终：

```text
K → K
```

这对“角色微动态 Loop”可能恰好符合某些场景，但它绝不能被描述为“支持显式首尾帧 Hybrid”。

### TODO

- preflight 校验 `last_frame_asset_id`
- staging last frame
- frontend reference selector
- compiler integration test
- route E2E test
- manifest slot assertion

---

## P0-4. Ref2VA prompt 没有真正绑定 Reference Role

MiniMax H3 官方对 Ref2VA 的核心建议不是简单说：

```text
Preserve the motion reference.
Same character.
```

而是要明确引用：

```text
<Picture 1>
<Picture 2>
<Video 1>
<Audio 1>
```

并说明每个 reference 的职责。

当前 `VideoSpecCompiler` 没有建立这种映射。

例如现状是：

```text
The same character (...)
Preserve the exact motion timing and body pose from the motion reference.
```

但模型并不知道：

```text
Picture 1 = 身份
Picture 2 = 服装
Video 1 = 动作轨迹
```

### 这会直接削弱所谓 A2A

当前只是“多个输入被接到图里”，还不是“多个输入被 Context 编译器明确分工”。

### 建议新增 `H3ReferenceContextCompiler`

输入：

```ts
{
  keyframe,
  lastFrame,
  characterRefs[],
  motionRef,
  prompt,
  scene,
  characters[]
}
```

输出：

```text
subject_definitions:
<Subject 1> is the character shown in <Picture 1> and <Picture 2>.
<Video 1> is the motion timing reference only.

reference_policy:
- identity: <Picture 1>, <Picture 2>
- costume: <Picture 2>
- motion timing: <Video 1>
- camera: locked
- first boundary: <Picture 3>
- last boundary: <Picture 4>

action:
...

temporal_constraint:
...
```

这才是 H3 Hybrid/A2A 应该有的“上下文工程”。

---

## P0-5. capability 的 G0 feature flag 并没有真正阻断生成

`getCapabilities()` 会检查：

```text
NOVASTORY_ENABLE_VIDEO=true
or
ENABLE_VIDEO_GENERATION=true
```

并把默认关闭写入 `missing_components`。

但：

```text
POST /api/videos/generate
```

只做：

```text
schema.parse
→ createTask
→ preflight
```

没有强制：

```text
capabilities.video_generation_enabled === true
```

### 测试甚至固化了这个行为

综合 route test 在默认 feature flag 未开启时，仍然期望：

```text
POST /generate => 202
```

因此当前 G0 是：

> **UI/diagnostic 提示，不是真正 gate。**

### 修复

统一：

```ts
assertVideoRuntimeReady()
```

由：

- `/preflight`
- `/generate`
- batch generate

全部复用。

当未启用或 runtime 不满足时：

```text
preflight.ready = false
generate = 409 / 503
```

不要发起“注定后面失败”的任务。

---

## P0-6. preflight 只校验业务资产，不校验运行环境

当前 preflight 能在以下情况下返回 `ready=true`：

- ComfyUI offline
- ffmpeg missing
- ffprobe missing
- H3 node missing
- model missing
- feature flag disabled

因为它没有合并 `getCapabilities()`。

### 建议

把 preflight 拆成：

```text
InputPreflight
RuntimePreflight
WorkflowPreflight
ResourcePreflight
```

最终统一返回：

```json
{
  "ready": false,
  "blockers": [],
  "warnings": [],
  "runtime": {},
  "compiled_spec": {},
  "compiled_workflow_summary": {}
}
```

---

## P0-7. `h3_workflow_ready` 的判断强度不够

当前 workflow validation 只检查：

1. workflow 中的 `class_type` 是否出现在 `/object_info`
2. manifest slot 指向的 node/input 是否存在

但 manifest 还声明了：

- `required_models`
- `required_custom_nodes`
- minimum version
- model fingerprint
- license fingerprint

这些实际上**没有被 runtime validation 消费**。

### 后果

即使：

```text
UNETLoader 存在
CLIPLoader 存在
VAELoader 存在
```

但具体 H3 model 文件没安装，capability 仍可能报告 workflow ready。

### 建议

增加：

```ts
validateModelSelectionAgainstObjectInfo()
validateCustomNodeVersion()
validateModelSha256()
validateComfyVersion()
```

至少必须验证 node 的 COMBO options 中确实有 manifest 指定的 model 文件。

---

## P0-8. 当前 QA continuity score 是模拟值，不是实际视频分析

`LoopAnalyzer.evaluateVideo()`：

```ts
const baseScore =
  rawErrorScore != null
    ? rawErrorScore
    : 1.2
```

然后：

```text
appearance = base × 0.9
motion = base × 1.1
flicker = base × 0.8
seam = weighted sum
```

但当前 `LoopCloser` 调用：

```ts
LoopAnalyzer.evaluateVideo({
  taskId,
  profile,
  probe
})
```

**没有传 `rawErrorScore`。**

因此 continuity score 当前几乎是固定值。

### 直接后果

系统目前不能检测：

- 首尾画面是否真的一致
- 人脸是否漂移
- 手/身体是否跳变
- 光照是否闪烁
- motion velocity 是否断裂

所以：

> 当前 `pass/manual_review/reject` 还不是视觉 QA gate。

这必须在对外宣称“自动闭环验收”之前修复。

---

## P0-9. LoopCloser 当前算法不是严格 5 秒闭环

当前 character loop：

1. 先标准化到 120f / 24fps / 5s
2. 切：
   - body = 0~4.5s
   - tail = 4.5~5.0s
3. `tail + body` 做 0.5s xfade
4. trim 到 5.0s

对于 FFmpeg xfade，理论输出长度为：

```text
0.5 + 4.5 - 0.5 = 4.5s
```

因此这一实现很可能实际把 5 秒变成约 4.5 秒，而后面的：

```text
trim=end=5.0
```

不会把缺失的时长补回来。

更重要的是，它没有“寻找最佳 seam”，只是固定把尾部与开头融合。

### 现有 QA 也不会拦住

技术 QA 接受：

```text
duration 4.0 ~ 6.0
```

因此约 4.5s 仍然 pass。

### 修复方向

LoopCloser 应该是：

```text
Analyze seam
→ choose best circular cut
→ blend only around the selected seam
→ preserve exactly 120 output frames
→ re-analyze
→ accept/reject
```

而不是固定：

```text
last 0.5s + first 4.5s
```

---

## P0-10. character identity prompt 可能选错人

视频 pipeline 当前：

```sql
SELECT *
FROM character
WHERE project_id = ?
LIMIT 1
```

然后把这个 character 传给 `VideoSpecCompiler`。

这和：

- 当前 scene 实际人物
- `character_reference_asset_ids`
- asset.character_id

没有建立对应关系。

### 多角色项目中会出现

```text
上传的是角色 B 的 reference
但 prompt subject_identity 用角色 A 的 description
```

这会直接损害 Ref2VA identity consistency。

图片生成链路已经有更成熟的“按 prompt mention / alias 识别角色”逻辑；视频链路不应该退回 `LIMIT 1`。

### 建议

优先级：

1. 从 `character_reference_asset_ids[].character_id` 解析 subject
2. scene/shot explicit character IDs
3. prompt mention resolver
4. 只有单角色项目才允许 fallback

---

# 4. P1：应在首轮验收前修复

## P1-1. GPU Lease 有 heartbeat API，但 pipeline 从未 heartbeat

video lease 默认超时：

```text
25 min
```

image：

```text
5 min
```

`heartbeat()` 已实现，但 video/image pipeline 没有周期调用。

### 风险

一旦某次 H3 > 25 min：

```text
Task A 仍在 Comfy 生成
→ Task B 请求 lease
→ isAvailable() 认为 A timeout
→ 回收 lease
→ B 开始占 GPU
→ 双任务显存冲突
```

### 修复

每 15~30s：

```text
GpuLeaseService.heartbeat(...)
generation_task.heartbeat_at = now
```

任务结束/异常一定 clear interval。

---

## P1-2. `queue_position` 创建时几乎必然是 0

`createTask()` 先：

```ts
getQueuePosition(taskId)
```

然后才：

```ts
runTaskPipeline()
```

真正的 `acquireLease()` 在 pipeline 内。

所以返回 202 时，该 task 还没进入 `waitQueue`。

### 修复

改为：

```text
enqueueTask()
→ 返回 queue_position
→ worker await lease
```

不要把“enqueue”和“worker acquire”分在两个时序阶段。

---

## P1-3. 远程 ComfyUI staging 不闭环

`MediaAssetService.stageAssetForComfy()`：

- copy 到 NovaStory 本地 staging
- 如果设置了 `comfyui.install_path`，再 copy 到：
  - `ComfyUI/input`

但如果：

```text
base_url = 远程 Comfy
install_path = 不在当前主机
```

实际没有调用 Comfy `/upload/image` 之类的 upload API。

因此当前 architecture 本质上要求：

> NovaStory 与 ComfyUI 位于同一台机器或共享文件系统。

### 修复

抽象：

```ts
interface ComfyAssetTransport {
  stage(asset): Promise<ComfyInputRef>
}
```

实现：

```text
LocalSharedFsTransport
ComfyHttpUploadTransport
```

---

## P1-4. Asset ownership / role-type consistency 未严格校验

preflight 的注释写了：

> must belong to project/scene

但实际只验证：

```text
asset exists
media_type matches
```

没有验证：

```text
asset.project_id === scene.project_id
asset.scene_id matches expected scene
scene_version matches
character_id matches subject
```

upload 也允许出现：

```text
role=motion_reference + image/png
role=character_reference + video/mp4
```

只是使用时才失败。

### 修复

建立 role matrix：

| Role | Allowed type |
|---|---|
| video_keyframe | image |
| video_last_frame | image |
| character_reference | image |
| motion_reference | video |
| raw_video | video |
| loop_master | video |
| narrative_final | video |
| poster | image |
| qa_report | json |

并在 register/upload/preflight 三层共用同一个 validator。

---

## P1-5. `/assets/register` 过于宽松

当前只要求：

```text
url
role
```

可注册：

- 不存在的文件
- 错误 media_type
- 错误 role
- 跨项目 URL

### 建议

使用 Zod schema + `MediaAssetService.validateLocalAsset()`。

---

## P1-6. `reprocess` 与 UI 契约直接冲突

后端：

```text
只有 raw_video 可 reprocess
```

前端播放器：

```text
对 active character_loop asset 显示“重新闭环”
→ 传 activeAsset.id
```

active asset 通常是：

```text
loop_master
```

因此正常流程很容易直接 400。

### 更正确的契约

UI 点击 final：

```text
final.parent_asset_id
→ raw_video
→ POST reprocess(raw_id)
```

或后端允许 final id，然后自动 resolve parent raw。

---

## P1-7. reprocess 会覆盖文件，但不会同步 DB derivative

即使传入正确 raw id：

`LoopCloser.process()` 会重写同一目录下：

- `final.mp4`
- `poster.jpg`
- `qa.json`

但 route 不会：

- 新建 final MediaAsset
- 更新旧 final SHA
- 更新 QA metadata
- 更新 status
- 更新 generation_task

这破坏了资产可追溯性。

### 最佳实践

reprocess 不覆盖 old final：

```text
raw_video
  ├─ loop_master v1
  └─ loop_master v2
```

每次都是 immutable derivative。

---

## P1-8. manual_review 当前会被当成 completed + ready

pipeline 只有：

```text
quality_grade == reject
```

才 rejected。

所以：

```text
manual_review
```

仍然：

```text
task.status = completed
asset.status = ready
```

未来一旦 QA 真实化，这会导致需要人工确认的视频自动成为 ready。

### 建议状态机

```text
pass          -> ready
manual_review -> review_required
reject        -> rejected
```

---

## P1-9. Provider 没有 overall execution deadline

`ComfyH3Provider` 有：

- connect timeout
- status timeout
- history polling

但没有整体：

```text
maxTaskDuration
```

如果 prompt 卡住，pipeline 可无限等待。

### 建议

preset 设 deadline：

```text
preview  : 15 min
standard : 30~40 min
```

并允许 heartbeat 续租，但不能无限生成。

---

## P1-10. 取消是 Comfy 全局 `/interrupt`

当前取消：

1. delete prompt from queue
2. POST `/interrupt`

`/interrupt` 是 Comfy 级动作，不天然绑定 NovaStory task。

如果用户同一个 Comfy 实例上还有其他非 NovaStory prompt，有误伤风险。

### 建议

- queued prompt：只 delete
- running 且确认 `prompt_id === owned active prompt`：才 interrupt
- 在 capability 中明确“exclusive Comfy mode”或“shared Comfy mode”

---

## P1-11. QA score 前端标尺写错

后端 `normalized_score` 是：

```text
0 ~ 100
```

前端却：

```ts
if (score >= 0.95) Grade S
else if (score >= 0.85) Grade A
```

例如当前 synthetic score 大约 88：

```text
88 >= 0.95
=> Grade S
```

因此几乎所有非零正常结果都会显示 S。

### 修复二选一

A：

```text
score 保持 0~100
S >= 95
A >= 85
```

B：

```text
后端 normalize 到 0~1
S >= .95
A >= .85
```

建议 A，更直观。

---

## P1-12. batch stop 只停 UI，不停已运行后端任务

`handleStopBatchGenerateVideo()`：

- close EventSource
- clear map
- stop batch loop

但没有对当前 task 调：

```text
cancelVideoTask
```

因此用户点“停止批量生视频”后，当前 H3 仍可能继续占用 GPU。

### 修复

维护：

```text
activeBatchVideoTaskId
```

Stop 时：

```text
cancel backend task
→ close SSE
→ stop further queue
```

---

# 5. P2：第二阶段优化

## P2-1. `getTask()` 未返回 schema 已声明的完整 artifact URL

`VideoTaskResponse` 设计上有：

- `raw_video_url`
- `poster_url`
- `qa_report_url`

但当前 `getTask()` 只主要返回：

- `output_url`
- `qa_report`

建议统一返回所有 derivative links，减少 UI 再查 media list 的耦合。

---

## P2-2. Generated final 与“Promoted final”状态没有清晰区分

当前非 reject final 默认就是：

```text
status=ready
```

而 UI 又把 `ready` 显示成：

```text
成片
```

这样：

- “候选已生成”
- “人工设为正式成片”

两个概念混在一起。

建议增加：

```text
draft
candidate
review_required
active
rejected
```

或者增加：

```text
is_active_final
```

---

## P2-3. 缺少 artifact retention / staging cleanup

当前：

- staging refs
- raw
- final candidates
- posters
- qa

都会持续增长。

建议项目级策略：

```text
staging: 24h
rejected candidates: configurable
raw: keep N days / keep when final promoted
active final: permanent
```

---

## P2-4. manifest 的实际运行 provenance 不够

建议每个 final manifest 存：

```json
{
  "workflow_id": "...",
  "workflow_sha256": "...",
  "comfy_version": "...",
  "node_versions": {},
  "model_sha256": {},
  "seed": 123,
  "sampler": "...",
  "scheduler": "...",
  "steps": 20,
  "input_asset_sha256": [],
  "prompt_ir": {}
}
```

这样后续“为什么这条好/坏”才可复现。

---

# 6. 当前 LoopCloser 为什么不够

## 6.1 它目前实际上做了什么

当前实现更准确的名字应是：

> `FixedBoundaryCrossfadePostprocessor`

而不是完整的 LoopCloser。

因为它没有：

- 搜索最佳切点
- 比较首尾 perceptual similarity
- 估计 optical flow
- 估计 velocity mismatch
- face/identity embedding
- 自动调 blend window
- 生成多个修复候选
- repair → re-evaluate loop

---

## 6.2 推荐的最小最优 Loop QA

第一版不要上过重的深度模型。

先做 4 个实际可测指标：

### A. Appearance seam

首尾帧：

```text
SSIM
+ normalized pixel/luma difference
```

可再加 LPIPS。

### B. Identity seam

人物 ROI：

```text
DINO embedding distance
or face embedding distance
```

如果没有稳定 face，fallback full-body crop。

### C. Motion seam

比较：

```text
flow[-2 → -1]
vs
flow[0 → 1]
```

而不是只比较 frame[-1] 与 frame[0]。

### D. Flicker seam

检查 seam 前后数帧：

```text
luma variance
color histogram shift
temporal SSIM
```

---

## 6.3 推荐 seam score

统一转成 0~10 error：

```text
seam_cost =
  0.35 * appearance
+ 0.30 * motion
+ 0.20 * identity
+ 0.15 * flicker
```

建议以现阶段产品目标作为第一版门线：

```text
PASS          <= 1.50
MANUAL_REVIEW  1.50 ~ 2.20
REJECT         > 2.20
```

不要继续用现在的：

```text
reject > 3.5
```

并且必须用一批真人/动画/半身角色样本做 calibration 后再固化。

---

## 6.4 Loop repair 正确顺序

```text
raw
 ↓
normalize
 ↓
analyze candidate seam windows
 ↓
choose best circular cut
 ↓
short adaptive blend (e.g. 6~12f)
 ↓
preserve 120 final frames exactly
 ↓
re-analyze
 ↓
pass / manual / reject
```

而不是：

```text
固定最后 0.5s
+ 固定最前 4.5s
+ xfade
```

---

# 7. Hybrid / H3 / A2A 推荐架构

## 7.1 不要把“Hybrid”定义成一个 JSON

Hybrid 应该是**策略层**。

```ts
type H3Strategy =
  | 'ref2va'
  | 'fl2va'
  | 'hybrid_two_stage'
  | 'hybrid_custom_experimental'
```

---

## 7.2 Strategy A：Ref2VA

适合：

- 人物身份
- 服装
- 风格
- motion video
- camera motion
- 多参考一致性

输入：

```text
Picture 1..N
Video 1..N
Prompt IR
```

使用官方 Ref2VA baseline。

---

## 7.3 Strategy B：FL2VA

适合：

- 强首帧
- 强尾帧
- 明确边界姿态
- K0 → K1
- K → K loop boundary

使用官方 FL2VA checkpoint。

---

## 7.4 Strategy C：Hybrid Two-stage

如果目标是：

> “既要人物/动作参考，又要严格首尾闭环”

不要未经验证地假设一个 Ref2VA checkpoint 可以同时提供 FL2VA 的 hard boundary semantics。

推荐：

### Stage 1 — Motion/Identity Candidate

```text
Ref2VA
+ character refs
+ motion video
+ tagged Context IR
```

得到动作和身份稳定的 candidate。

### Stage 2 — Boundary Constrained Regeneration / Selection

二选一：

#### 路径 1

提取候选的最佳 seam anchor：

```text
Kbest
```

再用：

```text
FL2VA Kbest → Kbest
```

生成强闭环版本。

#### 路径 2

保留 Ref2VA raw，通过真实 LoopAnalyzer：

```text
select seam
+ adaptive circular blend
```

如果 score <= target，避免二次生成。

### 优点

这样 Hybrid 是：

```text
策略组合
```

而不是：

```text
把所有 input socket 接进一个未经验证的 node
```

---

# 8. H3 Workflow 最佳实践建议

## 8.1 以官方 Comfy-Org workflow 为 Golden Baseline

Production workflow 应尽量从：

```text
Comfy-Org/workflow_templates
video_minimax_h3_r2v.json
```

派生。

所有 12GB 优化都应该是一项项改，并有 benchmark：

```text
baseline
→ lower resolution
→ quantized encoder
→ turbo LoRA
→ step reduction
→ offload
```

不能一次同时改 loader / sampler / node / frame count，然后无法知道哪个改变导致质量或兼容性问题。

---

## 8.2 CLIPLoader

改为官方 H3 类型：

```text
type = minimax
```

不要继续使用 `sd3`，除非有明确的节点作者说明与实机 benchmark。

---

## 8.3 Ref2VA sampler

优先建立：

### Quality baseline

```text
res_multistep
official scheduler path
20 steps baseline
```

### 12GB Preview

如果采用官方/可信来源的：

```text
MiniMax H3 Ref2V Turbo 4-step LoRA
```

则：

```text
4 steps
```

当前 6/10 step 是项目自定义折中，但没有对应 LoRA/benchmark 依据。

---

## 8.4 5s model length

Ref2VA baseline：

```text
124 model frames
```

最终产品仍可：

```text
120 frames / 24fps / 5.0s
```

二者分开。

---

## 8.5 Prompt IR

至少实现：

```text
subject_definitions
reference_roles
scene
action
camera
temporal_arc
negative_constraints
loop_contract
```

这是比继续堆自然语言句子更值得投入的部分。

---

# 9. Capabilities / Preflight 推荐实现

建议合并为一个强契约：

```ts
VideoRuntimeInspector.inspect(strategy, preset)
```

输出：

```json
{
  "feature_enabled": true,
  "comfy_online": true,
  "workflow_valid": true,
  "models": {
    "diffusion": true,
    "text_encoder": true,
    "video_vae": true,
    "audio_vae": true
  },
  "nodes": {
    "MiniMaxH3ReferenceToVideo": true
  },
  "sampler_supported": true,
  "ffmpeg": true,
  "ffprobe": true,
  "vram": {
    "free": 0,
    "estimated_required": 0
  },
  "ready": true,
  "blockers": []
}
```

`/generate` 必须重新检查一次，不能只相信 UI 之前调过 preflight。

---

# 10. MediaAsset 最佳实践

## 10.1 新增角色

建议增加：

```text
video_last_frame
```

不要让 first/last 都叫 `video_keyframe`。

---

## 10.2 ReferenceBinding

增加结构化表或 metadata：

```json
{
  "binding": {
    "h3_tag": "<Picture 1>",
    "role": "identity",
    "subject_id": "character:12",
    "weight_policy": "primary"
  }
}
```

这样 prompt compiler 与 workflow compiler 使用同一个 binding source。

---

## 10.3 不要为缺失 character refs 自动填 first frame

当前 compiler 对 3 个 character slots：

```text
refs[idx] || firstFrame
```

会把：

```text
只有 1 张人物图
```

变成：

```text
人物图 + first frame + first frame
```

这会无意改变 reference weighting。

如果 node 支持 optional，应传空；
如果 node 不支持 optional，应由 adapter 明确规定 fallback 语义，不能静默复制。

---

# 11. 测试审计

## 11.1 当前已有测试

存在：

- `backend/src/schemas/video.test.ts`
- `backend/src/services/video/video_spec_compiler.test.ts`
- `backend/src/services/video/video_workflow_compiler.test.ts`
- `backend/src/services/video/video_recovery.test.ts`
- `backend/src/routes/videos.test.ts`
- `backend/src/services/gpu_lease_service.test.ts`

这说明实现不是无测试开发。

---

## 11.2 当前测试真正覆盖到的内容

已覆盖：

- schema profile 条件
- character_loop motion ref 必填
- refs 数量上限
- prompt clean
- profile prompt
- workflow slot 注入
- API 基本状态码
- media list/promote
- queue concurrency
- orphaned task interrupted

---

## 11.3 关键缺失

### 缺失 1：Last Frame runtime

workflow test 只断言：

- positive
- negative
- first frame
- motion
- width/height/fps
- seed
- prefix

没有断言：

```text
last frame
```

所以 runtime 断链没有被捕获。

---

### 缺失 2：Feature gate

route 综合测试在 feature 默认关闭时仍期望：

```text
/generate => 202
```

测试把错误语义固化了。

---

### 缺失 3：UI ↔ Reprocess contract

后端测试明确：

```text
non-raw asset reprocess => 400
```

前端却传 final asset。

单层都“正确”，组合失败。

需要 contract test。

---

### 缺失 4：真实 ffmpeg Loop

没有用真正 5 秒视频验证：

```text
input duration
output duration
frame count
first/last seam
```

---

### 缺失 5：真实 H3 Comfy graph

没有：

```text
官方 object_info fixture
真实 /prompt validation
实机 12GB E2E
```

---

### 缺失 6：QA metric calibration

没有“好 loop / 坏 loop”测试集。

---

# 12. 本次无法宣称“测试通过”的原因

本次评审尝试在当前会话执行：

```text
git clone --depth 1 https://github.com/eric20170524/nova-story.git
```

但执行容器无法解析 `github.com`，因此无法在本地实际运行：

```text
npm install
npm run typecheck
npm test
npm run build
```

同时当前评审 HEAD：

```text
76826b0...
```

没有可见 GitHub Actions workflow run，也没有 commit status checks 可作为替代。

因此本报告严格区分：

- **源码中存在测试**
- **静态阅读显示测试意图合理**
- **本次会话未实跑**

不能把它写成“测试全部通过”。

---

# 13. 验收测试矩阵

## G0 — Runtime Gate

- [ ] `NOVASTORY_ENABLE_VIDEO` 未开启时 `/generate` 必须被拒绝
- [ ] Comfy offline 时 preflight 不得 ready
- [ ] ffmpeg/ffprobe 缺失时不得 ready
- [ ] model file 不存在时不得 ready
- [ ] H3 node/input 不兼容时不得 ready
- [ ] `CLIPLoader` 类型必须和目标 H3 workflow 一致

---

## G1 — Official H3 Ref2VA Baseline

- [ ] 直接导入官方 Ref2VA workflow 实机生成成功
- [ ] 5s length alignment 正确
- [ ] Qwen3VL loader type=`minimax`
- [ ] baseline sampler 对齐
- [ ] 1 图 + 1 视频 reference 成功
- [ ] 3 图 + 1 视频 reference 成功
- [ ] reference tags 在 prompt 中正确绑定
- [ ] seed 可复现

---

## G2 — FL2VA Boundary

- [ ] first only
- [ ] last only
- [ ] first + last
- [ ] K → K loop anchor
- [ ] explicit K0 → K1
- [ ] 前端传入 last frame 后，最终 workflow node 中实际不同于 first frame

---

## G3 — Hybrid

至少比较：

```text
A: Official Ref2VA
B: Official FL2VA K→K
C: Current Custom Hybrid
D: Two-stage Hybrid
```

每类至少：

```text
3 scenes × 3 seeds
```

记录：

- identity
- motion fidelity
- seam cost
- generation time
- peak VRAM
- failure rate

没有这一组 A/B 数据前，不应把 C 命名为“最佳实践”。

---

## G4 — Loop QA

准备：

```text
明显无缝
轻微跳变
严重跳变
身份漂移
曝光闪烁
运动速度断裂
```

要求：

- [ ] metric 能正确排序
- [ ] seam target 可校准
- [ ] repair 后 score 应下降
- [ ] 120f 保持不变
- [ ] 5.000s ± 容差
- [ ] manual/reject 状态不自动 ready

---

## G5 — Recovery / Cancel

- [ ] queued restart
- [ ] staging restart
- [ ] generating restart + history
- [ ] raw exists restart
- [ ] postprocessing restart
- [ ] duplicate recovery 不创建重复 final rows
- [ ] cancel queued
- [ ] cancel running
- [ ] cancel 不误伤其他 Comfy prompt
- [ ] batch stop 会取消 active task

---

# 14. 推荐 TODO

下面按“最小、最优、架构收敛”排序。

---

## P0 — 第一批：先把模型与 Gate 做对

### TODO-001 — 建立官方 Ref2VA Golden Workflow

**文件**

```text
backend/static/video-workflows/
```

**任务**

- [ ] 从 Comfy-Org 当前官方 R2V template 派生 API workflow
- [ ] 使用 `MiniMaxH3ReferenceToVideo`
- [ ] `CLIPLoader type=minimax`
- [ ] 使用 Ref2VA baseline sampler path
- [ ] 增加 audio VAE dependency（即使最终产品 strip audio）
- [ ] workflow id 改为 `minimax_h3_ref2va_official_12gb`
- [ ] 当前 custom graph 改名 `...hybrid_experimental`

**验收**

```text
官方 baseline 在目标 12GB 环境至少成功 3 次
```

---

### TODO-002 — H3 frame alignment

**文件**

```text
backend/src/services/video/video_spec_compiler.ts
backend/src/services/video/video_workflow_compiler.ts
```

- [ ] 加 `resolveH3ModelFrameCount(duration, fps)`
- [ ] 5s Ref2VA → 124 model frames
- [ ] delivery output 保持 120f
- [ ] 单元测试 4/5/10/15s

---

### TODO-003 — 真正接入 Last Frame

**文件**

```text
backend/src/services/video/video_generation_service.ts
backend/src/services/video/media_asset_service.ts
pages/DirectorMode.tsx
types.ts
```

- [ ] preflight validate
- [ ] staging
- [ ] compiler 参数
- [ ] UI selector
- [ ] request
- [ ] unit + route test

---

### TODO-004 — Feature/Runtime Gate 强制化

- [ ] 新增 `assertVideoRuntimeReady`
- [ ] preflight 合并 runtime capability
- [ ] generate 再次强检查
- [ ] UI button disabled
- [ ] route test 改为：
  - flag off → reject
  - flag on + runtime mocked ready → 202

---

### TODO-005 — 对齐 H3 model/node validation

- [ ] manifest parser 支持 `required_custom_nodes`
- [ ] 验证 minimum version
- [ ] 验证 COMBO model options
- [ ] real SHA-256
- [ ] Comfy version
- [ ] workflow sha

---

### TODO-006 — H3 Reference Context Compiler

新增：

```text
backend/src/services/video/h3_reference_context_compiler.ts
```

职责：

- [ ] Picture/Video tag
- [ ] subject definitions
- [ ] identity vs motion role
- [ ] camera
- [ ] action
- [ ] temporal contract
- [ ] loop contract
- [ ] refs binding manifest

---

### TODO-007 — 修正角色解析

- [ ] 优先由 reference asset `character_id` 确定
- [ ] 支持多角色
- [ ] 移除 `LIMIT 1` 默认身份
- [ ] 单角色项目才 fallback

---

## P0 — 第二批：让 QA 变成真的

### TODO-008 — Replace Synthetic LoopAnalyzer

新增真实：

- [ ] SSIM
- [ ] histogram/luma
- [ ] optical-flow velocity
- [ ] identity embedding（可 optional）
- [ ] seam window

移除：

```ts
rawErrorScore ?? 1.2
```

作为 production path。

---

### TODO-009 — 重写 LoopCloser

- [ ] best seam search
- [ ] circular cut
- [ ] adaptive 6~12 frame blend
- [ ] exact 120 frames
- [ ] repair 后 re-score
- [ ] no improvement → 保留 raw/fail

---

### TODO-010 — QA Gate 状态机

```text
pass          -> candidate/ready
manual_review -> review_required
reject        -> rejected
```

- [ ] 禁止 manual auto-promote
- [ ] target 初版：1.50 / 2.20
- [ ] calibration dataset

---

## P1 — 任务与运行稳定性

### TODO-011 — GPU heartbeat

- [ ] lease heartbeat timer
- [ ] DB heartbeat
- [ ] stale recovery
- [ ] test fake clock timeout

---

### TODO-012 — 正确 queue position

- [ ] queue insertion 与 createTask 同步
- [ ] worker await queue handle
- [ ] SSE queue update

---

### TODO-013 — Provider deadline / scoped cancel

- [ ] overall timeout
- [ ] owned prompt state
- [ ] queued delete
- [ ] running-only interrupt
- [ ] no global accidental interrupt

---

### TODO-014 — Remote Comfy asset transport

- [ ] local shared fs adapter
- [ ] HTTP upload adapter
- [ ] capability 显示 transport mode
- [ ] remote integration test

---

### TODO-015 — Reprocess immutable derivative

- [ ] final id → resolve raw parent
- [ ] 每次创建新 derivative
- [ ] poster/qa/media asset 同步
- [ ] 不覆盖旧 final
- [ ] UI 自动刷新并可比较 v1/v2

---

## P1 — UI / Contract

### TODO-016 — Reference Manager

每 scene 显示：

```text
First Frame
Last Frame
Character Ref 1..3
Motion Ref
```

- [ ] thumbnail
- [ ] replace/remove
- [ ] character binding
- [ ] validation badge

---

### TODO-017 — Fix QA score scale

- [ ] 0~100 统一
- [ ] S ≥ 95
- [ ] A ≥ 85
- [ ] B/manual
- [ ] F/reject

---

### TODO-018 — Batch stop cancel backend

- [ ] track active task id
- [ ] cancel active
- [ ] stop future scenes
- [ ] UI terminal state

---

## P2 — 可复现与运营

### TODO-019 — Provenance Manifest v2

- [ ] actual model SHA
- [ ] workflow SHA
- [ ] Comfy version
- [ ] node version
- [ ] prompt IR
- [ ] input SHA
- [ ] seed
- [ ] sampler
- [ ] execution metrics

---

### TODO-020 — Benchmark Harness

新增：

```text
backend/scripts/video-benchmark.ts
```

输出 CSV/JSON：

```text
strategy
scene
seed
time
peak_vram
identity
appearance
motion
flicker
seam
result
```

---

### TODO-021 — Retention Cleanup

- [ ] staging TTL
- [ ] failed candidate TTL
- [ ] raw retention
- [ ] active final never auto-delete

---

# 15. 推荐实施顺序

不要同时开很多支线。

## Phase A — 先证明 H3 baseline

```text
TODO-001
TODO-002
TODO-004
TODO-005
```

目标：

> 官方 Ref2VA 在目标机器稳定跑通。

---

## Phase B — 把 Hybrid 输入语义做对

```text
TODO-003
TODO-006
TODO-007
TODO-016
```

目标：

> 每个 reference 都有明确模型职责，Last Frame 真正进入图。

---

## Phase C — 真正解决 Loop

```text
TODO-008
TODO-009
TODO-010
TODO-017
```

目标：

> seam 指标来自真实视频，repair 之后有客观改善。

---

## Phase D — 稳定性

```text
TODO-011
TODO-012
TODO-013
TODO-014
TODO-015
TODO-018
```

---

## Phase E — 量化决定 Hybrid 方案

```text
TODO-019
TODO-020
TODO-021
```

最终用 benchmark 决定：

```text
官方 Ref2VA
vs
FL2VA K→K
vs
自定义 Hybrid
vs
Two-stage Hybrid
```

谁进入默认 runtime。

---

# 16. 最终验收定义

我建议把“红潮 Hybrid H3 A2A 生视频最佳实践完成”定义成以下条件全部满足，而不是“页面能点出 MP4”。

## Runtime

- [ ] feature gate 真阻断
- [ ] runtime preflight 完整
- [ ] target 12GB 环境稳定
- [ ] image/video GPU 不并发冲突
- [ ] 任务可取消/恢复

## Model

- [ ] official baseline 已验证
- [ ] custom Hybrid 有 A/B 证据
- [ ] reference tags 正确
- [ ] last frame 真正消费
- [ ] frame alignment 正确

## Quality

- [ ] QA 是真实测量
- [ ] 5.0s / 120f 精确交付
- [ ] seam PASS 目标 ≤ 1.50
- [ ] repair 后指标稳定改善
- [ ] identity drift 可检测
- [ ] manual/reject 不自动成为成片

## Asset

- [ ] raw immutable
- [ ] derivatives immutable
- [ ] lineage 完整
- [ ] model/workflow/input 可复现

## UI

- [ ] reference manager 完整
- [ ] capability blocker 可见
- [ ] batch stop 真取消
- [ ] QA 标尺正确
- [ ] candidate / active final 状态明确

---

# 17. 最终评审结论

当前实现值得保留，尤其以下结构不建议推倒：

- `VideoSpecCompiler`
- `VideoWorkflowCompiler + manifest`
- `MediaAsset`
- `GpuLeaseService`
- `ComfyH3Provider`
- raw → final derivative
- SSE + polling fallback
- startup recovery
- Director 视频模式

真正需要推翻/重做的是更小的一层：

```text
当前 H3 workflow baseline
当前 reference prompt binding
当前 LoopAnalyzer
当前 LoopCloser
若干跨层 contract
```

因此最优策略不是“重新做整个生视频系统”，而是：

> **保留现有工程骨架，先把模型执行图恢复到官方可验证基线；再以 Context IR / Reference Binding 实现真正 A2A；最后用真实 seam / motion / identity 指标替换模拟 QA，并让 LoopCloser 成为 analyze → repair → re-evaluate 的闭环。**

做到这一点后，NovaStory 的生视频链路才会从“能跑的集成原型”升级成“可量化、可复现、可验收的本地 H3 视频生产管线”。

---

## 外部基线参考

本次对当前生态做了同步核验，主要参考：

1. MiniMax-AI / MiniMax-H3 官方仓库与 README
   - H3-Base-FL2VA
   - H3-Base-Ref2VA
   - H3-Context-IR
   - 24 FPS / 4~15s / Ref2VA multimodal references

2. Comfy-Org / workflow_templates
   - `video_minimax_h3_r2v.json`
   - `MiniMaxH3ReferenceToVideo`
   - `CLIPLoader type=minimax`
   - `res_multistep`
   - H3 frame length alignment

3. Comfy-Org / MiniMax-H3 model files
   - Ref2VA INT8 ConvRot
   - Qwen3VL 32B NVFP4/AWQ
   - MiniMax H3 Video VAE

---

## 备注：文件位置

仓库 `.gitignore` 当前明确包含：

```text
/local/
```

因此本报告按用户要求生成在：

```text
local/docs/红潮_Hybrid_H3_A2A_生视频最佳实践与TODO.md
```

但**不建议把 `/local/` 强行改成 tracked GitHub 内容**。如果后续希望把这份评审纳入版本控制，建议复制到：

```text
docs/video/红潮_Hybrid_H3_A2A_生视频最佳实践与TODO.md
```

再通过独立 commit/PR 跟踪。
