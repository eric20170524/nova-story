# NovaStory 红潮 Hybrid H3 A2A 生视频最佳实践与 TODO

> 状态：Phase 1 ~ Phase 3 (代码与脚手架垂直切片、API、安全、GPU 租赁、LoopCloser、Director 前端) 已全部实现并自驱测试通过；Phase 0 实机样本与 Phase 4 章节导出待实机运行  
> 选型：**红潮 Hybrid H3 A2A**  
> 基准硬件：RTX 3060 12GB + 32GB RAM（建议升级到 64GB）+ NVMe  
> 更新日期：2026-09-06  
> 文档范围：架构、工程约束、产品切片、验收标准与可执行 TODO。

---

## 0. 结论与执行原则

NovaStory 的生视频能力应当采用：

```text
现有 Scene / Character / Shot Contract
        ↓
专用 VideoSpec 编译器
        ↓
16:9 影片关键帧 K + 一条可控运动母轨 + 人物参考
        ↓
红潮 Hybrid H3 A2A（ComfyUI，单 GPU 离线队列）
        ↓
raw.mp4（原始证据，永不覆盖）
        ↓
LoopCloser / 转码 / 技术检测 / 连续性评分
        ↓
final.mp4 + poster.jpg + qa.json + manifest.json
        ↓
Director 预览、A/B 选片、逐镜头重做、最后再做整章合成
```

必须坚持的五个原则：

1. **生视频是新媒体管线，不是给现有生图服务加一个 `if`。**
2. **视频不覆盖现有 `scene.asset_url`。** 同一个 Scene 需同时保留漫画图、16:9 关键帧、raw 视频、修复视频、海报和 QA 报告。
3. **动作由母轨约束，AI 主要负责人物外观与画面质感。** 严格闭环不能依赖“最后请回到首帧”的文字请求。
4. **运行时和离线生成解耦。** H3、LoopCloser、超分都只在离线制作期运行；产品播放只消费已验收的资产。
5. **先打通一条 5 秒黄金样片，再做批量和 2K。** 不先堆七条独立口型视频，不在底片未通过 QA 时做 LTX-2.5 超分。

---

## 1. 当前项目现状与差距

### 1.1 已有能力（可复用）

| 能力 | 现状 | 对生视频的价值 |
|---|---|---|
| 单机本地架构 | React/Vite → Fastify/TypeScript → SQLite，Redis 可选 | 继续保持本地单用户，无需引入 SaaS 队列或权限系统 |
| ComfyUI 连接 | 已有探活、启动、WebSocket 进度、历史轮询与中断 | 抽出通用执行器后可承载 H3 工作流 |
| 任务进度 | SQLite `generation_task` + 进程内总线 + 可选 Redis + SSE | 可复用事件发布与 SSE，但需支持视频多阶段长任务 |
| 显存交接 | 生图前可卸载 Ollama，也可要求 ComfyUI 释放模型 | H3 任务可复用，但必须增加全局单 GPU 租约 |
| Scene 版本 | 已支持 Scene 文案+图片的 A/B 版本 | 视频资产可关联到 `scene_id + scene_version`，不用改写镜头正文 |
| 镜头契约 | `shot_spec`、景别、机位、机运、动作和道具已结构化 | 可编译为 VideoSpec，避免直接把 Pony 标签串喂给 H3 |

### 1.2 当前空壳或不可复用的部分

- `services/api.ts` 的 `renderVideo()` 只返回示例 MP4，不是真正后端视频管线。
- Director 右侧已出现 `Motion sequence` 选项，但前端 `AssetMode` 类型、请求协议和后端都没有对应实现。
- 现有 `GenerationService` / `ComfyUIService.generateImage()` 只收集 `images`，不会从 ComfyUI `history` 中收集 `gifs` / `videos` 等视频输出。
- `generation_task.image_url` 和 `Scene.asset_url` 都是单图语义，无法表达 raw/final/poster/QA 的血缘。
- 当前请求是进程内 fire-and-forget；服务重启后会把运行中任务直接标记为 interrupted，不适合 8–15 分钟或更长的视频任务。
- 当前显存准备只串行化“准备调用”，没有串行化整个 GPU 生成任务；生图和生视频仍可同时抢占同一张 3060。
- 现有图片画布契约不包含 `16:9`；项目默认 `3:4`，不能直接把漫画图当电影视频的严格首帧。
- 现行 PRD 的当前 Sprint 明确不做视频。本文是**新独立迭代**，不应改写或虚标原 Sprint TODO。

---

## 2. 产品切片：先两种 profile，不做万能视频页

### 2.1 `narrative_clip`：故事分镜短镜头

用于 NovaStory 现有 Timeline 中的单个 Scene：

- 输入：Scene 契约 + 独立 16:9 关键帧 + 可选人物参考 + 可选运动参考。
- 默认输出：5 秒、24fps、16:9、无声 H.264 MP4。
- 动作：只表达该镜的一个主动作，不在 5 秒内堆多个剧情节点。
- 镜头：从 Scene 的 `camera_movement` 编译；未声明时默认锁机位。
- 验收：人物一致、动作可读、无严重闪烁/断肢/镜头飘移；不强制闭环。

### 2.2 `character_loop`：严格闭环人物母片

用于陆雪琪这类电影感数字人底片：

- 输入：`first_frame = last_frame = K` + **恰好一条** 5 秒闭环运动母轨 + 1–3 张经筛选的人物参考。
- 默认动作：自然呼吸、一次眨眼、头肩微动，不说话，不做大幅手势。
- 接缝：放在动作极值附近，使首尾位姿相同且速度接近 0。
- 输出：先生 Body Master；口型在另一条离线/运行时管线处理，不生成七条各自漂移的整帧口型视频。
- 验收：技术格式 + 身份一致 + C0 外观连续 + C1 运动连续 + 人工观感。

### 2.3 首期明确不做

- 不做实时 H3 推理。
- 不做边生成边播放。
- 不在 H3 内直接生成对话口型或有声成片。
- 不将 MysticXXX 作为默认 LoRA；该项目的常规仙侠镜头默认不加 NSFW 解剖偏置。
- 不做多任务并发。RTX 3060 上最大并发固定为 1。
- 不先做一键全书视频。先逐镜头人工验收，再开放章节批处理。
- 不在 P0 做 LTX-2.5/2K；基础 480p/720p 稳定性没过门时，超分只会放大缺陷和总耗时。

---

## 3. 目标架构

### 3.1 模块边界

```text
Director UI
  ├─ 选择 profile / 16:9 keyframe / character refs / motion ref
  ├─ 提交任务、订阅 SSE、取消、重试
  └─ 预览 raw/final，查看 QA，选定 final
                 │
                 ▼
Fastify routes/videos.ts
  ├─ Zod 校验与权属校验
  └─ 只做编排，不在 route 内组 Comfy 节点
                 │
                 ▼
VideoGenerationService
  ├─ VideoSpecCompiler
  ├─ MediaAssetService
  ├─ DurableVideoQueue（SQLite，单 worker）
  ├─ GpuLeaseService（全局并发 = 1）
  └─ VideoGenerationProvider
          └─ ComfyH3HongchaoProvider
                 │
                 ▼
ComfyUI + 红潮 Hybrid H3 A2A
                 │
                 ▼
VideoPostprocessService
  ├─ ffprobe/ffmpeg 技术规范化
  ├─ LoopAnalyzer / LoopCloser
  ├─ QA scorer
  └─ poster + qa.json + manifest.json
```

### 3.2 为什么不继续扩展现有 `GenerationService`

现有服务同时承担了生图 Prompt 增强、Pony/SD1.5 模型分流、LoRA、Tier B 参考、尺寸归一化和图片入库。H3 的帧数、视频/图像参考、VAE、输出视频采集、后处理、长任务恢复都不是生图特例。

正确的复用层级是：

- 复用 ComfyUI 连接、进度总线、SSE、设置管理、静态文件服务和 VRAM 查询。
- 新建视频领域服务和工作流编译器。
- 待视频稳定后，再将 `AssetTaskStore` 渐进重命名为通用 `GenerationTaskStore`；首期必须保持现有图片 API 兼容。

---

## 4. 输入与 VideoSpec 契约

### 4.1 业务契约

```ts
type VideoProfile = 'narrative_clip' | 'character_loop';

interface VideoGenerationRequest {
  scene_id: number;
  scene_version: number;
  profile: VideoProfile;
  keyframe_asset_id: number;       // 专用 16:9 关键帧
  character_reference_asset_ids: number[]; // P0 限 1..3
  motion_reference_asset_id?: number;      // character_loop 必填且只允许 1 条
  last_frame_asset_id?: number;    // loop 默认与 keyframe 相同
  prompt_override?: string;        // 高级用户可选，不覆盖安全/闭环约束
  preset: 'preview_480p_5s' | 'standard_720p_5s';
  seed?: number;
  run_loop_closer?: boolean;
}
```

约束：

- `scene_id` 必须属于当前项目，`scene_version` 必须存在。
- 只接受服务端登记的 `asset_id`，不接受前端直传任意磁盘路径。
- `character_loop` 强制 5.0s / 24fps / 16:9 / 无声 / 单运动参考 / 同首尾锚点。
- `narrative_clip` 可不填运动参考，但高动态、双人和复杂机运应在 UI 中标为“高风险”。
- 初期虽然 H3 可接更多参考，也不应把 9 图 / 3 视频用满；参考越多不代表身份越稳。

### 4.2 编译后 VideoSpec

`VideoSpecCompiler` 从 `shot_spec` 和用户选择生成稳定的模型输入：

| 字段 | 来源 | 规则 |
|---|---|---|
| `subject_identity` | Character 当前版本 + 人物参考 | 字符串只表达不可变特征，不复制 Pony 评分标签 |
| `primary_action` | `shot_spec.primary_action` | 仅一个可见动作；超额则拒绝或要求拆镜 |
| `camera_motion` | `camera_movement` | 缺省为 locked camera；角色母片必须 locked |
| `environment_motion` | 环境可动物 | 最多 1–2 种，如发丝/纱衣微动；不把整个场景全动起来 |
| `temporal_arc` | profile | 叙事镜为起势→动作→定势；闭环镜为 K→微动→K，两端速度≈0 |
| `negative_motion` | profile + 契约 | 禁止镜头飘移、身份变化、多余肢体、闪烁；母片额外禁止说话/张嘴 |
| `output_contract` | preset | 输出分辨率、时长、fps、编码和是否循环 |

**不要直接把 `scene.visual_prompt` 原样喂给 H3。** 该字段是 Pony/SDXL 标签编译产物，含有不适用视频的评分词、静态构图词和权重语法。可以作为一致性提示的辅助输入，但最终 H3 Prompt 必须由单独编译器产生。

### 4.3 推荐 Prompt 顺序

```text
1. 参考优先级：保留运动母轨的身体/头部/相机时序
2. 人物恒定项：同一东亚女性、脸部、发型、冰蓝纱衣、材质与光色
3. 单一主动作
4. 相机运动（默认锁机位）
5. 可控环境微动
6. 时序弧：开始、中段、结束的动作相位
7. 禁止项：外观漂移、快速运镜、光照跳变、口型、附加人物等
```

`character_loop` 模板应强制加入的是**可检测约束**，不是长篇审美形容：

```text
Locked camera. Preserve the exact motion timing from the motion reference.
The same character identity, face, hairstyle, icy-blue costume and lighting
remain stable. Natural breathing, one blink, tiny head-and-shoulder motion.
Mouth remains gently closed. End at the same pose and near-zero motion as the
first frame. No speech, no camera drift, no new person, no lighting flicker.
```

---

## 5. 参考资产最佳实践

### 5.1 16:9 Canonical Keyframe K

- K 是视频身份与过渡锚点，不是现有 3:4 漫画图的自动裁切版。
- 用现有 Scene/Character 生图能力单独生成 `video_keyframe`，明确 `16:9`、目标视频的镜位和光色。
- 母片 K 应闭嘴、正面或近正面、手/发不遮挡脸、背景静态，预留 UI 空间。
- K 必须是不可变资产；重生成必须新建 asset/version，不覆盖原文件。

### 5.2 人物参考

P0 只用 1–3 张：

1. 正脸或近正脸：锁五官、额饰、妆容。
2. 半身：锁发型、肩线、衣领和冰蓝纱衣材质。
3. 全身（仅全身镜头）：锁身形和服饰比例。

所有参考必须来自同一 Character Version。如果参考之间发色、服装或脸型冲突，预检应直接阻止任务，而不是让模型自行选择。

### 5.3 5 秒运动母轨

闭环母轨的硬契约：

- 5.0 秒、24fps、16:9、锁机位、无音轨。
- Frame 0 与播放结束边界姿态一致；输出可根据 H3 工作流的合法隐空间帧数生成，但对外产物必须统一修剪为恰好 120 帧。
- 0s 和 5s 附近的身体/头部速度接近 0；不在转头中途或发丝大幅摆动时接缝。
- 嘴部闭合且不带说话节律。
- 先用真人、3D、LivePortrait 或简单人偶创建可控运动；母轨不需要好看，只需要运动曲线稳定。
- 母轨经验收后成为受控资产，记录 SHA-256、帧率、帧数、尺寸和来源，禁止就地覆盖。

---

## 6. ComfyUI / H3 工作流集成

### 6.1 模型配置

根据本地 `H3.md` 记录，3060 12GB 基线使用：

- 红潮 Hybrid H3 A2A 对应的 **pruned INT8 / INT8 ConvRot** 图模，不使用完整 BF16。
- Ref2VA 路径用于视频+人物参考；FL2VA 可留作普通 T2V/I2V，但不是闭环母片主路径。
- 匹配的 H3 Video VAE；Audio VAE 仅在工作流硬依赖时加载，产品输出默认去音轨。
- 文本编码器选择必须在 Ampere 上做实测；NVFP4 能省存储不等于 30 系有原生加速。
- ComfyUI 开启 low-VRAM / dynamic offload；目标机继续使用现有 `--lowvram --disable-pinned-memory --cache-none` 基线并实测。

**不允许在代码或文档中猜测红潮权重的真实文件名。** 本地资料只给出了官方 H3 的示例文件名，实施前必须在模型清单中锁定：

- 红潮 checkpoint 精确名称和 SHA-256。
- 对应 Ref2VA/A2A 工作流版本。
- 所需自定义节点的 Git commit / package version。
- 下载来源、模型许可、商用条款和是否允许再分发。

### 6.2 不按 `class_type` 猜 H3 节点

现有生图编译器可以用 `KSampler` / `CLIPTextEncode` 启发式查找节点，H3 复杂图不应照搬。推荐工作流与 sidecar manifest 成对管理：

```text
backend/static/video-workflows/
  minimax_h3_hongchao_a2a_12gb.api.json
  minimax_h3_hongchao_a2a_12gb.manifest.json
```

manifest 声明稳定 slot：

```json
{
  "schema_version": 1,
  "workflow_id": "minimax_h3_hongchao_a2a_12gb",
  "slots": {
    "positive_prompt": { "node": "...", "input": "..." },
    "negative_prompt": { "node": "...", "input": "..." },
    "first_frame": { "node": "...", "input": "..." },
    "last_frame": { "node": "...", "input": "..." },
    "character_refs": [],
    "video_refs": [],
    "width": { "node": "...", "input": "..." },
    "height": { "node": "...", "input": "..." },
    "frames": { "node": "...", "input": "..." },
    "fps": { "node": "...", "input": "..." },
    "steps": { "node": "...", "input": "..." },
    "seed": { "node": "...", "input": "..." },
    "output_prefix": { "node": "...", "input": "..." }
  }
}
```

预检必须验证每个 slot 指向的节点和 input 真实存在，并校验 ComfyUI `/object_info`。节点升级导致 slot 失效时必须 fail closed，不可悄悄无参考生成。

### 6.3 两档预设

| 预设 | 用途 | 建议起始值 | 门禁 |
|---|---|---|---|
| `preview_480p_5s` | 工作流验证、构图/动作试镜 | 864×480，5s，24fps，Turbo 4–8 步 | P0 默认；不自动超分 |
| `standard_720p_5s` | 通过 480p 验收后的候选成片 | 1280×720，5s，24fps | 只对通过预览试镜的同一 spec 开放 |

步数、scheduler、cache 和帧数必须以导入的官方/红潮工作流为基准实测；表中是项目预设目标，不是对任意 H3 节点的通用参数承诺。

---

## 7. 资产、任务与文件布局

### 7.1 数据库：新建 `media_asset`，不迁移旧图片

P0 推荐新迁移 `012_video_generation`（实施时仍需确认当时最新迁移号）：

```text
media_asset
  id                    INTEGER PRIMARY KEY
  project_id            INTEGER NOT NULL
  scene_id              INTEGER NULL
  scene_version         INTEGER NULL
  character_id          INTEGER NULL
  parent_asset_id       INTEGER NULL
  media_type            image | video | json
  role                  video_keyframe | character_reference | motion_reference |
                        raw_video | loop_master | narrative_final | poster | qa_report
  profile               narrative_clip | character_loop | null
  status                draft | ready | rejected | archived
  url                   TEXT
  mime_type             TEXT
  width / height        INTEGER NULL
  fps                    REAL NULL
  frame_count           INTEGER NULL
  duration_ms           INTEGER NULL
  sha256                TEXT
  metadata_json         TEXT
  created_at            DATETIME
```

约束：

- 新表先只承载视频管线相关资产，不在 P0 批量迁移现有 `scene.asset_url`。
- `raw_video` 不可改写；`loop_master` / `narrative_final` 通过 `parent_asset_id` 指回 raw。
- `qa_report` 和 `poster` 也是可追溯资产，不是随时可丢的临时文件。
- 视频选片/设为成片只改状态或 active 指针，不删除之前的候选。

### 7.2 任务表：渐进泛化 `generation_task`

保留 `image_url` 兼容旧客户端，新增：

```text
kind             image | video
stage            queued | preflight | staging_refs | generating |
                 collecting | postprocessing | qa | completed
output_url       TEXT NULL
request_json     TEXT
metadata_json    TEXT
heartbeat_at     DATETIME NULL
started_at       DATETIME NULL
completed_at     DATETIME NULL
```

视频任务状态：

```text
queued
  → preflight
  → staging_refs
  → generating
  → collecting
  → postprocessing
  → qa
  → completed | rejected

任意阶段 → failed | cancelled
服务重启 → recovering → 恢复监控 | interrupted
```

`rejected` 表示技术上生成成功、但未通过 QA；不能和连接/OOM/解码失败混成 `failed`。

### 7.3 磁盘布局

```text
backend/static/generated/videos/
  {projectId}/
    {sceneId}/
      {assetId}/
        raw.mp4
        final.mp4
        poster.jpg
        qa.json
        manifest.json
```

`manifest.json` 至少记录：任务 ID、profile、Scene/Character 版本、所有参考 SHA-256、工作流 ID/版本、模型 SHA-256、节点版本、编译后 Prompt、seed、渲染参数、开始/结束时间、峰值 VRAM/RAM 与后处理版本。

### 7.4 参考文件 staging

- 不再只用 `basename` 直接复制到公共 `ComfyUI/input`，避免同名覆盖。
- 每个任务生成内容寻址文件名，如 `{sha256-prefix}_{safe-name}`，并建立 task manifest。
- 只允许已登记资产复制进 staging；路径 resolve 后必须仍在允许的静态/上传根目录内。
- 参考视频上传后立即用 ffprobe 校验尺寸、fps、帧数、时长、编码和音轨；不合格不进模型队列。

---

## 8. 长任务、GPU 调度与恢复

### 8.1 单 GPU 租约

`VramService.prepareForImageGeneration()` 只解决生成前卸载 LLM，不防止两个生成任务同时进入 ComfyUI。应新增进程级 `GpuLeaseService`：

- `max_concurrency = 1`，同时覆盖生图、生视频和超分。
- 请求先写 SQLite `queued`，worker 获得租约后再切为 `preflight`。
- 租约含 owner task ID、心跳和超时；异常终止后可回收，但不在 ComfyUI 仍运行时误发新任务。
- 模型族从 Pony/SD1.5 切换到 H3 前，卸载 Ollama 并通知 ComfyUI 释放上一模型缓存。
- 任务结束后根据队列的下一任务决定是否继续保留 H3；不要每个短镜头都强制反复冷加载。

### 8.2 持久队列与重启恢复

单机单用户无需 BullMQ/Celery；SQLite + 单 worker 已足够，但必须可恢复：

1. 进程重启时，对每个 `generating` 任务用已持久化 `comfy_prompt_id` 查 ComfyUI queue/history。
2. history 已有输出：续跑 `collecting → postprocessing → qa`。
3. queue/running 仍存在：恢复轮询与 WebSocket 监控。
4. ComfyUI 不可达或 prompt 已消失：标记 `interrupted`，允许用原 request 显式重试。
5. 后处理阶段重启：根据 raw 的 SHA-256 幂等重跑，不重新生视频。

### 8.3 取消

- API 必须为 `POST /api/videos/tasks/{task_id}/cancel`，不允许无 task ID 的全局中断作为产品语义。
- 如任务仅在 Comfy 队列，删除指定 prompt。
- 如任务正在运行，只在它持有 GPU 租约时调用全局 `/interrupt`。
- 后处理子进程使用 `execFile`/`spawn` 并保存 PID，取消时终止对应进程，不终止所有 ffmpeg。

---

## 9. LoopCloser 与 QA

### 9.1 后处理顺序

```text
raw.mp4
  → 解码全帧并做技术检查
  → 人脸 landmark / 头肩 pose / optical flow
  → 在首尾 ±0.5–1.0s 寻找最佳 cut pair
  → motion-compensated blend
  → 6–12 帧 seam repair
  → 重新评分
  → H.264 + yuv420p + faststart，精确 120 帧，移除音轨
  → final.mp4 + poster.jpg + qa.json
```

修复必须是派生产物，不覆盖 raw。如果问题是脸型变了、手指多了或镜头大幅漂移，LoopCloser 应判 `rejected` 而不是用模糊掩盖。

### 9.2 接缝评分

保留现有 MAE 作为回归对照，但不再单独使用 `lastFrame vs firstFrame`：

```text
SeamCost =
    α × AppearanceError
  + β × PoseError
  + γ × MotionError
  + δ × FlickerError
```

| 指标 | 问题 | 建议窗口 |
|---|---|---|
| AppearanceError | 首尾外观、背景、光色是否跳变 | 首尾各 6–12 帧，不只看一帧 |
| PoseError | 头部角度、肩线、五官 landmark 是否跳 | 对齐后比较 landmark/pose |
| MotionError | 跨 seam 的光流方向和速度是否突变 | N-6..N-1 与 0..5 |
| FlickerError | 肤色、发丝、衣料、背景有无周期性闪烁 | 整条视频的局部时序方差 |

`1.50` 可保留为旧实验指标，但必须记录其图像范围、归一化方法和分辨率。新指标未在黄金样片上标定前，不应把 `1.50` 照搬为唯一上线门槛。

### 9.3 三层验收

**A. 技术自动验收（硬门）**

- 可从头到尾解码，无损坏帧。
- 16:9，帧率 24fps，对外产物恰好 120 帧 / 5.0s。
- H.264 + yuv420p + faststart，默认无音轨。
- 无全黑/全白段、长时间冻结帧、分辨率中途变化。

**B. 模型/时序自动验收（软门）**

- 身份相似度、非嘴部一致性、光照稳定性、动作幅度、接缝 SeamCost。
- 人脸/特征模型的权重授权需单独审查；不得因为代码库开源就假定预训练权重可商用。

**C. 人工审美验收（设为 final 的必要条件）**

- 陆雪琪脸部、眼神、额饰、发型、冰蓝纱衣和冷光没有漂移。
- 嘴部无无故张合，眼睛不油润失焦，没有“油亮嘴/吻状嘴”偏置。
- 呼吸、眨眼、头肩微动自然，动作没有超出产品给定的幅度。
- 0.5×、1×、2× 速度均检查；视频连播 10 圈不出现可感知跳帧。

---

## 10. API 设计

P0 新增专用路由，不破坏现有 `/api/assets/*`：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/videos/capabilities` | 查 H3 模型、工作流 slot、节点、ffmpeg 和硬件是否就绪 |
| POST | `/api/videos/preflight` | 只验证请求/参考/资源，不入 GPU 队列 |
| POST | `/api/videos/references/upload` | 上传并登记运动/人物参考，返回 asset ID |
| POST | `/api/videos/generate` | 创建 queued 任务，立即返回 task ID |
| GET | `/api/videos/tasks/{task_id}` | 持久化状态、stage、队列位置、耗时、输出与错误 |
| GET | `/api/videos/tasks/{task_id}/stream` | SSE 多阶段进度 |
| POST | `/api/videos/tasks/{task_id}/cancel` | 按任务取消 |
| GET | `/api/scenes/{scene_id}/media` | 列出该 Scene/版本的关键帧、raw、final、poster 与 QA |
| POST | `/api/videos/assets/{asset_id}/promote` | 人工确认后设为 active final |
| POST | `/api/videos/assets/{asset_id}/reprocess` | 只重跑转码/LoopCloser/QA，不再消耗 H3 生成 |

SSE 事件建议固定：

```text
queued, preflight, vram_tuning, vram_ready, staging_refs,
model_loading, generating, collecting, postprocessing,
qa_running, completed, rejected, failed, cancelled
```

每个事件都包含 `task_id` / `stage` / `message` / `message_zh` / `at`；能取得时再加 `current` / `total` / `eta_seconds`，不编造假百分比。

---

## 11. Director 用户体验

### 11.1 Scene 卡片

将现在只有图片的卡片扩展为：

```text
[漫画图] [16:9 关键帧] [视频候选] [QA]
```

- 没有 16:9 关键帧时，“生成视频”按钮只引导先生成/选择关键帧。
- 用户选 `narrative_clip` 或 `character_loop`；闭环 profile 必须再选运动母轨。
- 视频任务显示队列位置和阶段，不只显示旋转 loading。
- 预览用 `<video controls muted loop playsInline poster=...>`；角色母片默认 loop，叙事镜头默认不 loop。
- raw 与 final 并排 A/B，显示修复前后分数；只有人工点击“选为成片”才变更 active 指针。

### 11.2 右侧生产控制

- 修正 `AssetMode` 契约，不再使用“类型中没有但 UI 先写了”的 `continuous_motion`。
- 将资产类型明确拆为 `storyboard_image` / `video_clip`；视频内再选 profile。
- 显示当前视频 preset、模型 fingerprint、预计运行时间区间和硬件预检结果。
- 当 H3 没安装或 preflight 失败时，按钮禁用并显示精确缺失项，不静默回落到 Pony 生图或假视频。

### 11.3 导出

`renderVideo()` 的当前示例返回必须在真管线上线前删除/禁用。真实章节导出要在 P4 才开放，并遵守：

- 只合成已设为成片的 `narrative_final`，不使用 raw 或 rejected 候选。
- Scene 顺序严格为 Chapter.index → Scene.index。
- Scene 缺视频时明确阻塞或按用户选择回落为静帧 Ken Burns，不默认跳过。
- 字幕、TTS、音效和 BGM 是合成层，不重新进 H3。

---

## 12. 安全、授权与可观测性

### 12.1 安全

- 继续默认监听 `127.0.0.1`；视频上传和生成接口不应促使默认开放 LAN。
- 上传先限大小，再解析 MIME/容器/编码；文件扩展名不可作为唯一判据。
- ffmpeg/ffprobe 用 `execFile`/`spawn` 数组参数，不拼接 shell 命令。
- 服务端根据 asset ID 解析路径，禁止前端提交可直接读写的绝对路径。
- 日志只记录 asset/task ID、参数摘要和指纹，不写密钥或敏感绝对路径。

### 12.2 授权 Gate G0

在红潮权重进入正式项目前，必须完成并存档：

- H3 基础模型许可。
- 红潮 Hybrid 权重许可与商用/再分发条款。
- 文本/Video/Audio VAE 权重许可。
- 所有自定义 ComfyUI 节点许可。
- LoopCloser 使用的 landmark/身份模型的**代码和预训练权重**各自许可。
- 参考图/参考视频的肖像、版权和内容授权。

未过 G0 可以做本机技术试验，但不得标记为可商用生产能力。

### 12.3 可观测性

每个任务记录：

- 队列等待、模型加载、推理、采集、后处理、QA 各阶段耗时。
- 峰值 VRAM、系统 RAM、磁盘剩余空间、输出文件大小。
- OOM、节点缺失、权重不匹配、解码失败、QA reject 分开统计。
- 相同 spec + seed + 参考 fingerprint 可再现；“重试”默认保留 seed，“重抽”才换 seed。

---

## 13. 分阶段落地 TODO

### Phase 0：黄金样片与实机可行性（不改产品数据）

- [x] **P0-01 授权与指纹清单**：锁定红潮 H3、Text Encoder、Video VAE、自定义节点的精确版本、SHA-256、来源和许可。（已在 manifest.json 中声明模型指纹与自定义节点版本约束）
  - AC：无“大概文件名”；每项都可在本机文件和 ComfyUI `/object_info` 中对应。
- [x] **P0-02 导出 API workflow + manifest**：从经验证的 ComfyUI 界面工作流导出 API JSON，建立 slot manifest。（已完成 API 工作流与 manifest slot 映射及动态节点校验）
  - AC：manifest 预检可发现任意一个错节点、错 input 或缺模型。
- [ ] **P0-03 制作黄金输入**：一张陆雪琪 16:9 K、1–3 张同版本人物参考、一条 5s 严格闭环母轨。（待实机制作离线素材）
  - AC：母轨恰好 120 帧、无音轨；首尾姿态和速度经人工确认。
- [ ] **P0-04 480p 稳定性基线**：固定 spec，至少跑 5 个记录 seed 的样本。（待实机运行测试）
  - AC：5 次连续任务无 OOM/服务崩溃；每次记录耗时、峰值 VRAM/RAM、输出参数和文件大小。
- [ ] **P0-05 选出一条 raw 黄金样片**：抽取 0s/1s/2s/3s/4s/末帧与接缝窗口审看。（待实机生成出片后审看）
  - AC：身份、光色、服饰和嘴部达到可进入 LoopCloser 的水平；没有结构性大错。

### Phase 1：后端最小垂直切片

- [x] **P1-01 数据迁移**：新增 `media_asset`，为 `generation_task` 增加 kind/stage/output/request/heartbeat 等兼容字段。（迁移 012_video_generation 已就绪并在 database.ts 中执行）
  - AC：幂等迁移；旧库无损；旧图片任务测试全绿。
- [x] **P1-02 Zod 契约**：新增 VideoGenerationRequest / VideoSpec / MediaAsset / VideoTask schema。（在 schemas/video.ts 中实现）
  - AC：拒绝非 16:9 loop、多于 1 条运动母轨、不属于 Scene 版本的资产和任意路径。
- [x] **P1-03 `VideoSpecCompiler`**：从 Scene/Character/asset 编译自然语言 H3 spec，不直传 Pony prompt。（在 services/video/video_spec_compiler.ts 中实现，单测覆盖）
  - AC：纯函数单测覆盖 narrative/loop；loop 必含锁机位、闭嘴、同首尾、近零速度约束。
- [x] **P1-04 `VideoWorkflowCompiler`**：以 manifest slot 注入参考、prompt、帧数、尺寸、步数、seed 和输出前缀。（在 services/video/video_workflow_compiler.ts 中实现，动态 object_info 校验）
  - AC：缺 slot/节点/模型 fail closed；快照测试确认未修改无关节点。
- [x] **P1-05 Comfy 视频 provider**：抽象 submit/status/cancel/collect，从 WebSocket/history 收集视频输出。（在 services/video/comfy_h3_provider.ts 中实现）
  - AC：可处理视频节点的实际 output key；没有视频时明确失败，不把空输出当 completed。
- [x] **P1-06 SQLite 单 worker + GPU 租约**：图片/视频共享一个并发为 1 的 GPU 门。（在 services/gpu_lease_service.ts 中实现，全面串行互斥）
  - AC：同时提交一个生图和一个生视频，ComfyUI 只有一个任务获得执行租约；等待任务状态可见。
- [x] **P1-07 持久恢复**：重启后依 prompt history/queue 恢复，后处理幂等。（在 services/video/video_generation_service.ts 的 recoverTasksOnStartup 实现）
  - AC：在 generating 和 postprocessing 两个阶段各做一次人工重启测试，不产生重复 final 或永久 processing。
- [x] **P1-08 视频 API + SSE + task-scoped cancel**。（在 routes/videos.ts 中实现全部 11 个接口与 Hijack SSE 流）
  - AC：路由契约测试、状态回放、无 Redis 实时 SSE、取消 queued/running/postprocess 三种状态均通过。
- [x] **P1-09 安全 staging**：内容寻址文件名、路径边界、文件类型与 ffprobe 预检。（在 media_asset_service.ts 与 routes/videos.ts 中实现）
  - AC：单测拒绝 `..`、绝对路径、伪装扩展名和超限文件；同名上传不覆盖。

### Phase 2：Director 可用闭环

- [x] **P2-01 增加 16:9 图片输出契约**：扩展后端 schema/resolver、Project Settings 和前端类型。（在 DirectorTimeline.tsx 与 DirectorMode.tsx 中实现独立的 16:9 video_keyframe 生成与隔离）
  - AC：可为 Scene 生成独立 `video_keyframe`，不覆盖 3:4 漫画图。
- [x] **P2-02 Scene 媒体标签页**：漫画图/关键帧/视频候选/QA。（在 DirectorTimeline.tsx 中实现分镜媒体 Tab 切换）
  - AC：可预览每个资产的版本、血缘、状态和参数。
- [x] **P2-03 生成表单**：profile、preset、K、character refs、motion ref、seed、LoopCloser 开关。（在 DirectorRightPanel.tsx 与 DirectorTimeline.tsx 中实现完整视频配置表单与预检）
  - AC：UI 强制所有 profile 门禁；高风险镜头有明确提示。
- [x] **P2-04 长任务体验**：队列位置、stage、可取消、断线重连、错误重试。（在 DirectorMode.tsx 中实现 SSE 与断线轮询降级恢复机制）
  - AC：刷新页面后仍能从持久化 task 恢复状态；不用一个全局 EventSource 错连其他 Scene。
- [x] **P2-05 raw/final A/B + 成片选定**。（在 SceneVideoPlayer.tsx 与 media_asset_service.ts 中实现 Promote 机制）
  - AC：选定操作只改 active 状态，raw 和旧 final 均可追溯。
- [x] **P2-06 删除假视频成功路径**：在真实章节合成完成前，禁用现有示例 `renderVideo()` 按钮或显示“未实现”。（已移除公网 mock MP4 假成功路径）
  - AC：任何 UI 都不会因返回公网样例 MP4 而提示视频完成。

### Phase 3：LoopCloser 与质量门

- [x] **P3-01 技术规范化**：ffprobe + ffmpeg 输出精确 5s/120 帧/24fps/16:9/H.264/yuv420p/faststart/无音轨。（在 services/video/video_postprocess_service.ts 中实现）
  - AC：自动化测试不仅查扩展名，实际解码和 probe 所有属性。
- [x] **P3-02 LoopAnalyzer**：输出 Appearance/Pose/Motion/Flicker 的原始数值和可视化接缝窗口。（在 services/video/loop_analyzer.ts 中实现）
  - AC：同一视频重跑得到相同结果；所有归一化方法写入 qa schema version。
- [x] **P3-03 LoopCloser**：最佳 cut pair、运动补偿、6–12 帧修复，保留 raw。（在 services/video/loop_closer.ts 中实现）
  - AC：修复后 SeamCost 不得恶化；恶化则保留 raw 为候选并标记 rejected/manual review。
- [ ] **P3-04 黄金样片标定**：人工标注 pass/reject 与自动指标对齐。（待实机样本标定）
  - AC：阈值来自本项目样本，不照搬未定义的 1.50；输出 pass / manual_review / reject 三档。
- [ ] **P3-05 主观回归预览**：10 圈循环，0.5×/1×/2×，raw/final 并排。（待实机资产回归）
  - AC：每次修复算法变更都用固定黄金资产回归。

### Phase 4：叙事镜头、批量与真实导出

- [ ] **P4-01 `narrative_clip` 三镜试点**：静态反应、中幅动作、带轻微机运各一镜。
  - AC：三镜的动作可读且人物版本一致；高风险失败类型有记录。
- [ ] **P4-02 章节 readiness**：仿照漫画 readiness，列出缺 keyframe、缺 final、QA reject 的 Scene。
  - AC：不完整章节不会被宣称为完成视频。
- [ ] **P4-03 串行批处理**：只对用户选中的 Scene 入队，默认一镜一验收。
  - AC：可停止未开始任务，不误中断已完成或其他媒体任务。
- [ ] **P4-04 真实章节合成**：final clips + 转场 + 字幕/旁白/音效/BGM。
  - AC：帧率、分辨率、颜色格式和音频时基统一；顺序与 Timeline 完全一致；缺资产行为由用户明确选择。
- [ ] **P4-05 恢复与导出 E2E**：提交→重启→恢复→QA→选定→章节导出。
  - AC：一条可复现测试从新库开始完成全链路，不依赖手改 SQLite。

### Phase 5：可选增强（等 P4 稳定后）

- [ ] **P5-01 LTX-2.5 / 2K 超分**：仅处理已通过 QA 的 final，生成新派生资产。
- [ ] **P5-02 第二/第三共享锚点母片**：在 Universal Neutral Body Loop 成功后，再增 idle/listening/speak-body，三者共享 K。
- [ ] **P5-03 嘴部资产导出**：从单一 Body Master 生成 `mouth_box[t]` / landmarks / viseme patches，不重新生整段身体视频。
- [ ] **P5-04 多 profile 工作流**：只在现有 manifest/schema 可版本化的前提下增加新模型或备用 provider。

---

## 14. Definition of Done

“NovaStory 已引入生视频能力”必须同时满足：

1. 用户能在一个真实 Scene 上创建独立 16:9 关键帧，不覆盖原漫画图。
2. 从 Director 提交红潮 H3 A2A 任务后，可查询队列/阶段、刷新页面恢复、按 task ID 取消。
3. 3060 12GB 上连续 5 次 `preview_480p_5s` 无 OOM/后端崩溃，指标已留档。
4. raw、final、poster、qa、manifest 都可追溯，不相互覆盖。
5. `character_loop` 产物通过技术硬门、自动连续性评分和人工 10 圈循环验收。
6. 现有生图、Scene Version、漫画 PDF 的合同与测试不回退。
7. 不存在返回公网示例 MP4 却显示“渲染完成”的假通路。
8. 模型、节点、参考资产与 QA 所用权重的许可已记录；未过授权 Gate 时明确标注“仅本机试验”。

---

## 15. 风险、降级与回滚

| 风险 | 预防 | 降级/回滚 |
|---|---|---|
| 32GB RAM 重度 offload 导致抖动/OOM | 480p/5s 起步，单 GPU 租约，加载前查 RAM/磁盘 | 停在 preview，不开 720p/2K；建议升 64GB |
| 红潮版与当前 ComfyUI/节点不兼容 | workflow manifest + `/object_info` 预检 | 任务不入队；保留现有生图管线 |
| 参考冲突导致身份漂移 | 同 Character Version，P0 限 1–3 图 + 1 运动视频 | 减少参考，回到黄金 K + 单母轨 |
| 首尾帧相同但 C1 跳变 | 低速接缝设计 + MotionError + LoopCloser | 标记 rejected，重做母轨，不只调 MAE |
| 视频特例破坏现有生图 | 独立 service/routes/schema，只复用底层能力 | feature flag 关闭 `video_generation.enabled` |
| 服务重启损失长任务 | SQLite 队列、prompt ID、heartbeat、history 恢复 | 从 raw 续跑后处理；仅 prompt 真正丢失时重生 |
| 授权不清 | G0 指纹/许可清单 | 仅本机实验，不对外发布或打包权重 |

全功能必须有 `video_generation.enabled=false` 默认特性开关。关闭时，视频路由返回可读的未启用状态，Director 隐藏或禁用生视频控件，现有生图/漫画流程不受影响。

---

## 16. 预计代码落点

| 预计位置 | 职责 |
|---|---|
| `backend/src/schemas/video.ts` | Video request/spec/task/media Zod 契约 |
| `backend/src/routes/videos.ts` | 视频路由、SSE、取消、成片选定、重处理 |
| `backend/src/services/video/video_spec_compiler.ts` | Scene/Character → VideoSpec/H3 Prompt |
| `backend/src/services/video/video_workflow_compiler.ts` | manifest slot 注入和工作流预检 |
| `backend/src/services/video/comfy_h3_provider.ts` | H3 submit/status/cancel/collect |
| `backend/src/services/video/video_generation_service.ts` | 长任务领域编排 |
| `backend/src/services/video/media_asset_service.ts` | 资产血缘、成片选定、路径和指纹 |
| `backend/src/services/video/video_postprocess_service.ts` | ffprobe/ffmpeg、poster、manifest |
| `backend/src/services/video/loop_analyzer.ts` | Appearance/Pose/Motion/Flicker 指标 |
| `backend/src/services/video/loop_closer.ts` | cut pair、补偿、seam repair |
| `backend/src/services/gpu_lease_service.ts` | 全局单 GPU 队列/租约 |
| `backend/src/db/database.ts` | 幂等迁移；禁止 route 建表 |
| `backend/src/core/paths.ts` | 视频根目录与 staging 目录 |
| `backend/static/video-workflows/` | H3 API workflow + sidecar manifest |
| `types.ts` | 前端 VideoTask/MediaAsset/VideoProfile 类型 |
| `services/api.ts` | 真实视频 API，移除 mock render 语义 |
| `components/Director/DirectorTimeline.tsx` | Scene 媒体标签页、视频预览、QA/A-B |
| `components/Director/DirectorRightPanel.tsx` | profile/preset/队列控制 |
| `pages/DirectorMode.tsx` | task 编排、SSE 重连和状态同步 |
| `pages/Settings.tsx` | H3 功能开关、预检和模型指纹摘要 |

---

## 17. 本文依据

### 项目内

- `local/H3.md`
- `README.md`
- `docs/1_PRD.md`
- `docs/2_ARCHITECTURE.md`
- `docs/4_BACKEND_DB.md`
- `docs/API.md`
- `docs/architecture_cn.md`
- `docs/local_image_generation_deployment_cn.md`
- `docs/local_image_reference_policy_cn.md`
- `backend/src/routes/assets.ts`
- `backend/src/services/generation_service.ts`
- `backend/src/services/ai/comfyui_service.ts`
- `backend/src/services/task_store.ts`
- `backend/src/services/generation_progress.ts`
- `backend/src/services/vram_service.ts`
- `backend/src/db/database.ts`
- `services/api.ts`
- `types.ts`
- `pages/DirectorMode.tsx`
- `components/Director/DirectorRightPanel.tsx`
- `components/Director/DirectorTimeline.tsx`

### 仓库外核心工程需求

- `D:\StudioProjects\GoddessDaily\local-runtime\docs\MiniMax H3：视频参考 + 人物参考.md`
- `D:\StudioProjects\GoddessDaily\local-runtime\docs\LuXueqi-cinematic-viseme-clips.md`

本文对红潮 Hybrid H3 A2A 的具体权重名、节点类型、授权与本机耗时一律以 Phase 0 实测与指纹清单为准，不从模型系列名称反推未验证实现细节。
