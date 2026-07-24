# NovaStory 架构文档 (Architecture)

## 1. 系统概览 (System Overview)

NovaStory 是一个基于 AI 的辅助创作工具，旨在帮助创作者从文本故事生成可视化的分镜脚本和视频素材。系统采用前后端分离架构，前端使用 React (Vite)，后端使用 FastAPI (Python)。

## 2. 核心架构与功能模块 (Core Architecture & Flow)

目标工作流：
```text
章节文本
  → 自动分镜 (Auto-Storyboard)：按叙事动作生成正式时间线场景
  → 单场景九镜头覆盖 (9-Shot Coverage)：扩展单场景的 9 个候选镜头
  → 预览与生图 (Asset Mode)：单图或 3×3 分镜联系表
  → 候选镜头应用或提升为正式镜头
```

### 2.1 自动分镜 (Chapter-level Auto-Storyboard)
- **定位**: 将整章文本按叙事动作单元拆解为正式的时间线场景列表（`Scene`）。
- **API**: `POST /api/timeline/generate` (`mode="narrative"`)
- **说明**: 废弃章节级 `nine_shot_coverage` 模式。如向该接口传入旧模式将返回 HTTP 400 错误与迁移指引。

### 2.2 单场景九镜头覆盖 (Single-Scene 9-Shot Candidate Coverage)
- **定位**: 针对已拆解的**单个场景卡片**生成该动作节点下 9 个不同景别/角度的候选镜头（1-ELS, 2-LS, 3-MLS, 4-MS, 5-MCU, 6-CU, 7-ECU, 8-Low Angle, 9-High Angle）。
- **数据结构**:
  - `CoverageGroup`: 包含 `id`, `source_scene_id`, `version`, `status`
  - `CoverageShot`: 包含 `id`, `coverage_group_id`, `slot`, `shot_size`, `camera_angle`, `camera_movement`, `visual_prompt`, `promoted_scene_id`
- **存储机制**: 存储于独立的覆盖组数据表中，默认不加入正式时间线，避免污染主镜头轴。
- **候选操作**:
  - **应用至本场景 (`POST /api/scenes/coverage/{shot_id}/apply`)**: 将该候选镜头的景别、角度、运镜和画面描述更新至源场景。
  - **提升为正式镜头 (`POST /api/scenes/coverage/{shot_id}/promote`)**: 将该候选镜头插入为主时间线的正式场景卡片。

### 2.3 场景图片输出模式 (`assetMode`)
- **单镜头图片 (`single_image`)**: 为场景卡片生成 1 张单独的普通素材图片。
- **3×3 分镜联系表 (`contact_sheet_3x3`)**: 为场景卡片生成 1 张 3×3 九宫格合成图。
- **API**: `POST /api/assets/generate` (`mode="standard"` 或 `mode="cinematic_grid"`)

### 2.4 九宫格提示词工具 (Grid Prompt Tool)
- **定位**: 位于故事编辑器的辅助工具。仅生成可复制的 3×3 电影感提示词，不创建分镜，不触发生图。

---

## 3. 数据安全与持久化 (Data Safety & Persistence)

1. **重新分镜事务安全**:
   - 当章节已有分镜时，重新分镜前显示弹窗提示覆盖风险。
   - 后端使用数据库事务 (`with db.begin()`)，只有 LLM 成功生成并校验后才原子替换旧分镜。失败时自动回滚，旧数据完全保留。
2. **分镜卡片编辑持久化**:
   - 接口: `PUT /api/timeline/scene/{scene_id}`
   - 字段: 支持保存 `shot_type`, `camera_movement`, `camera_angle`, `visual_prompt`, `audio_prompt`, `dialogue`, `duration`, `negative_prompt`。

---

## 4. API 端点清单 (API Endpoints Summary)

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/timeline/generate` | POST | 章节级自动分镜（叙事动作拆解） |
| `/api/timeline/{chapter_id}` | GET | 获取章节时间线 |
| `/api/timeline/scene/{scene_id}` | PUT | 更新持久化场景卡片 |
| `/api/scenes/{scene_id}/coverage` | POST | 生成单场景 9 候选镜头覆盖组 |
| `/api/scenes/{scene_id}/coverage` | GET | 获取单场景覆盖组及候选镜头 |
| `/api/scenes/coverage/{shot_id}/apply` | POST | 将候选镜头属性应用至源场景 |
| `/api/scenes/coverage/{shot_id}/promote` | POST | 将候选镜头提升为正式时间线场景 |
| `/api/assets/generate` | POST | 提交图片素材生成任务 |
