# NovaStory 小说文档导入 TODO

创建：2026-08-25  
更新：2026-08-26

## 当前状态

- 分支：`feature/novel-document-import`
- PR：`#7 feat: structured novel document import with preview`
- PR 状态：Ready for review
- 自动验证：当前 PR head 全绿
- 合入建议：Squash merge

主链路已经闭环：

```text
选择 TXT / Markdown / NovaStory JSON
  → POST /api/projects/import/preview
  → Canonical File Parser
  → NovelImportDraft / NovaStory Project
  → 用户检查预览
  → POST /api/projects/import/commit
  → commitProjectImportFile()
  → SQLite Transaction
  → 新 Project
```

legacy 兼容链路也已收敛：

```text
POST /api/projects/import
  → commitProjectImportFile()
  → 与 canonical commit 相同的 parser / persistence strategy
```

Markdown 小说进入写作系统后的链路：

```text
Markdown
  → NovelImportDraft
  → Project + Chapter.summary + Chapter.content
  → Story Bible settings
  → Project Settings 可编辑
  → Layered Context
  → 稳定创作约束 + 动态章节记忆
  → AI 写作 / 技能重写
```

已使用《失声的梦核游乐园》实际文档结构验证：识别 10/10 章；“章节概要 / 正文”边界正确；题材可保留为 `genre + story_tags`；不会根据模糊描述擅自创建人物。

---

## 设计原则

- **统一入口**：Preview 与 Commit 共用 `parseProjectImportFile()`；所有提交路径共用 `commitProjectImportFile()`。
- **纯解析层**：Markdown / TXT / JSON 文件解析不依赖数据库。
- **确定性导入**：只提取源文档明确提供的信息，不用 AI 猜人物或世界观。
- **信息不丢失**：无法映射的小节进入 `settings.import_info.unmapped_sections`。
- **最大化复用现有模型**：使用 Project / Chapter / Character / Glossary / Story Bible，不新增独立 Novel 表。
- **原子写入**：Project、Chapter、Character、Glossary 或 Native Restore 在事务中完成。
- **正确错误边界**：输入与解析问题返回 4xx；数据库故障保持 5xx，不伪装成文件格式错误。
- **上下文预算受控**：POV、Tone、Story tags 独立表达并设置固定字符预算，不污染 `style`。
- **稳定约束优先**：创作约束始终与章节记忆并存，不能被 fallback 逻辑绕过。

---

# P0：Canonical import 核心闭环

## Canonical model

- [x] `NovelImportDraft`
  - [x] source：filename / format
  - [x] project：title / description / settings
  - [x] chapters：index / title / summary / content / status
  - [x] characters
  - [x] glossary
  - [x] unmappedSections
  - [x] warnings

## TXT

- [x] 保持既有 `text_import.ts` 行为
- [x] TXT → `NovelImportDraft`
- [x] 中文 / 英文章标题识别无回归
- [x] 无结构 TXT 降级为单章

## Markdown

- [x] `.md` / `.markdown`
- [x] `# 作品名` → `project.title`
- [x] `## 简介` → `project.description`
- [x] `## 创作信息` → Story Bible / import metadata
- [x] `题材` → `genre + story_tags[]`
- [x] style / main_plot / character_relations / pov / tone
- [x] `## 第 N 章` → Chapter
- [x] `### 章节概要` → `chapter.summary`
- [x] `### 正文` → `chapter.content`
- [x] 结构 heading 不进入正文
- [x] 章节正文前置段落不丢失
- [x] 章节之后的非章节 `##` 资料不丢失
- [x] 未识别 project / chapter 小节保留
- [x] 无章节标题时降级为单章并 warning
- [x] 不自动创建文档未明确给出的人物

## Canonical file parser

- [x] `parseProjectImportFile()`
- [x] `.txt`
- [x] `.md`
- [x] `.markdown`
- [x] `.json`
- [x] `.novastory.json`
- [x] unsupported extension → 415
- [x] decode / malformed input → 400
- [x] parser 层无数据库依赖

## Persistence / commit orchestration

- [x] `importNovelDraft()`
- [x] `restoreNovaStoryJsonProject()`
- [x] `commitProjectImportFile()` 统一选择持久化策略
- [x] Project / Chapter / Character / Glossary 创建
- [x] `chapter.summary` 正确落库
- [x] Story Bible settings 正确落库
- [x] source / warnings / unmappedSections → `settings.import_info`
- [x] SQLite transaction
- [x] 失败 rollback

## Native NovaStory JSON v1 restore

- [x] project title / description / settings
- [x] chapters
- [x] characters / visual tags
- [x] scenes / shot spec
- [x] coverage groups
- [x] coverage shots
- [ ] 完整 character / scene version-history restore（P1.5）

---

# P0：Route 收敛

- [x] `POST /api/projects/import/preview`
- [x] `POST /api/projects/import/commit`
- [x] Dashboard 主链路使用 Preview + Commit
- [x] input/parser error 与 persistence error 分离
- [x] legacy `POST /api/projects/import` 保持向后兼容
- [x] legacy TXT / Markdown 委托 `commitProjectImportFile()`
- [x] legacy NovaStory JSON 委托 `commitProjectImportFile()`
- [x] 删除 legacy route 内重复的 inline JSON restore
- [x] canonical 与 legacy 共享同一 parser / persistence strategy
- [ ] 后续版本正式标记 legacy endpoint deprecated

---

# P0：测试与 CI

## Import 测试

- [x] Markdown parser 单元测试
- [x] 《失声的梦核游乐园》10 章 regression fixture
- [x] unknown chapter section preservation
- [x] trailing project section preservation
- [x] chapter preamble preservation
- [x] single-chapter fallback
- [x] Preview 不写数据库
- [x] Preview empty file → 400
- [x] Preview unsupported file → 415
- [x] Canonical Markdown Commit → DB
- [x] Canonical unsupported file → 415
- [x] Canonical JSON → Chapter / Scene / Coverage
- [x] legacy Markdown → DB
- [x] legacy JSON → Chapter / Scene / Coverage
- [x] legacy unsupported file 使用 canonical 415
- [x] TXT 既有测试无回归

## 全量质量门禁

- [x] Root/frontend TypeScript typecheck
- [x] Backend TypeScript typecheck
- [x] Backend 全量 test suite
- [x] Production build
- [x] GitHub Actions CI
- [x] 跨平台测试发现，不依赖 shell glob
- [x] character / scene version tests 自行创建父级 fixture
- [x] 数据库外键保持开启

---

# P1：Import Preview

## Backend

- [x] 只解析，不写数据库
- [x] 无 preview token / temp file / cache table
- [x] 返回 source + mode
- [x] 返回 project title / description / settings
- [x] 返回章节标题、summary/content 状态
- [x] 返回章节 / 概要 / 正文 / 人物数量
- [x] 返回 JSON scene / coverage / shot 数量
- [x] 返回 warnings
- [x] 返回 unmappedSections

## Dashboard

- [x] 文件选择
- [x] 解析预览
- [x] 展示作品名、格式、类型、简介
- [x] 展示 genre / story tags
- [x] 展示章节、概要、正文、人物计数
- [x] 展示前 12 个章节结构
- [x] 展示 warnings / 未映射小节
- [x] 文件变化清空旧 preview
- [x] 用户确认后 Commit
- [x] 成功后创建项目并关闭弹窗

---

# P1：Story Bible 映射、编辑与消费

## 保存与编辑

- [x] genre
- [x] style
- [x] main_plot
- [x] character_relations
- [x] story_tags
- [x] pov
- [x] tone
- [x] import_metadata
- [x] import_info
- [x] Project Settings 可查看 / 编辑上述核心字段
- [x] 保存时保留未知 settings key
- [x] 不为 metadata 增加数据库 column

## AI Context

- [x] genre / style / main_plot / character_relations
- [x] story_tags / pov / tone
- [x] POV / Tone / Story tags 不拼入 style
- [x] Story tags 最多前 8 个
- [x] Tags / POV / Tone 固定字符预算
- [x] `buildCreativeConstraints()` 统一格式化
- [x] DB → WritingService → Layered Context 集成测试
- [x] 有前文章节记忆时，最终生成 prompt 仍包含稳定创作约束
- [x] CINEMATIC_REWRITE / ADD_CONFLICT / REVERSE_PLOT 复用同一创作约束

---

# P1.5：Native backup fidelity

该部分独立于“小说文稿 → 新项目”，不阻塞当前 PR。

- [ ] 设计 `.novastory.json` format v2
- [ ] 导出 / 恢复 `chapter.condensed_content`
- [ ] 导出 / 恢复 `character_version`
- [ ] 导出 / 恢复 `scene_version`
- [ ] active_version 必须引用实际存在的 version
- [ ] v1 → v2 compatibility tests

---

# P2：附加文档 / 已有项目扩展

## 产品模式

- [ ] 设计“添加到已有小说”流程
- [ ] Preview 中明确目标项目与写入影响
- [ ] 区分 primary manuscript 与 supplemental document
- [ ] 默认不自动覆盖现有正文 / Story Bible

## 数据模型评估

- [ ] 评估 `project_document`
  - [ ] primary_manuscript
  - [ ] outline
  - [ ] worldbuilding
  - [ ] character_notes
  - [ ] reference
  - [ ] other
- [ ] 文档 checksum / duplicate detection
- [ ] source filename / mime / import time / metadata

## 冲突策略

- [ ] append
- [ ] replace
- [ ] merge
- [ ] preview-only
- [ ] 字段级 source fact 与 existing value 对比
- [ ] 不允许静默覆盖

## AI Context

- [ ] 按 document type 选择性注入
- [ ] 单文档和总量预算
- [ ] 避免所有附加资料无差别塞入 prompt
- [ ] 明确 source fact 与 AI inference 边界

---

# P2：更多格式

- [ ] DOCX
- [ ] EPUB
- [ ] PDF 暂不作为小说工程主文稿；未来定位为 reference document

---

# 明确不做

当前主链不引入：

- 向量数据库 / RAG
- PDF OCR
- AI 自动脑补人物
- AI 自动补全世界观
- 独立 Novel 表体系
- 为每个 metadata 增加数据库字段
- Preview 临时数据库表
- Preview token / server-side temp-file session
- 未经确认的已有项目自动 merge

---

# 当前完成定义

```text
TXT / Markdown
  → Preview
  → Canonical Parser
  → NovelImportDraft
  → Commit
  → commitProjectImportFile()
  → ProjectImportService
  → Project + Chapters + summary + content + Story Bible
  → Project Settings
  → Layered Context
  → 稳定创作约束 + 动态章节记忆
  → AI 写作 / 技能重写
```

```text
NovaStory JSON
  → Preview
  → Canonical Parser
  → Commit
  → commitProjectImportFile()
  → NovaStory JSON Restore Service
  → Project + Chapter + Character + Scene + Coverage
```

```text
Legacy /projects/import
  → commitProjectImportFile()
  → 与 canonical commit 完全相同的解析和持久化链路
```

## 合入检查

- [x] 功能实现完成
- [x] Canonical / legacy route 收敛
- [x] Markdown / TXT / JSON 回归测试
- [x] Preview / Commit 回归测试
- [x] Story Bible → final writing prompt 回归测试
- [x] Typecheck / full backend tests / production build
- [x] 当前 PR head CI 全绿
- [x] PR Ready for review

当前非阻塞后续项：legacy endpoint deprecation、Native backup v2、已有项目附加资料、DOCX / EPUB。
