# NovaStory 小说文档导入 TODO

创建：2026-08-25  
更新：2026-08-26

## 当前状态

分支：`feature/novel-document-import`  
Draft PR：`#7 WIP: novel document import and preview`

当前已经打通两阶段小说文档导入主链路：

```text
选择文件
  → POST /api/projects/import/preview
  → Canonical File Parser
  → NovelImportDraft / NovaStory Project
  → 用户检查预览
  → POST /api/projects/import/commit
  → Transaction
  → 新 Project
```

Markdown 文稿链路：

```text
Markdown
  → NovelImportDraft
  → ProjectImportService
  → Project
  → Chapter.summary
  → Chapter.content
  → Story Bible settings
```

已使用《失声的梦核游乐园》实际上传文档结构做规则验证：识别 10/10 章，第一章“章节概要 / 正文”边界正确，题材可拆分为 `genre + story_tags`。

> 验证边界：仓库当前没有 GitHub Actions status checks。本分支已经补充 parser / preview / commit / DB persistence 自动化测试代码，但当前工具环境无法执行仓库依赖，因此不能把“测试已编写”表述为“npm check 已实际运行通过”。合入前仍必须在正常开发环境执行本文末尾的验证命令。

---

## 目标

在不重构现有 Project / Chapter / Character / Glossary / Story Bible 数据模型的前提下，把现有“TXT / NovaStory JSON 导入新项目”升级为统一、可预览的小说文档导入链路。

核心原则：

- 小说文稿先解析成统一 `NovelImportDraft`。
- Preview 与 Commit 必须共享同一套 parser，避免规则漂移。
- Preview 不写数据库、不创建临时 token、不保存临时文件。
- Commit 重新解析同一个 File 后原子落库。
- `.novastory.json` 是原生项目备份/恢复路径，不强行压成 manuscript Draft。
- Importer 只提取源文档明确提供的信息，不用 AI 猜人物、设定或世界观。

> 语义校正：当前 NovaStory backup format 并不导出完整 character/scene version history，因此本轮 JSON service 的目标是“保持既有项目恢复语义与 Chapter / Character / Scene / Coverage 数据”，不宣称完整 lossless version-history restore。完整版本历史备份应独立升级 export format。

---

## 设计原则

- **架构收敛**：格式 parser、preview、persistence 分层。
- **单一解析源**：Preview / Commit 共用 `parseProjectImportFile()`。
- **纯解析层**：file parser / Markdown parser / TXT adapter 不依赖数据库模块。
- **确定性导入**：只保存 source fact，不做 AI inference。
- **最大化复用现有模型**：优先复用 `project.description`、`project.settings`、`chapter.summary`、`chapter.content`、`character`、`glossary`。
- **信息不丢失**：无法映射的小节进入 `import_info.unmapped_sections`。
- **原子写入**：Project / Chapter / Character / Glossary 同一事务成功或回滚。
- **错误边界正确**：输入/解析错误返回 4xx；DB/persistence 错误不能伪装成“文件格式错误”。
- **不引入无必要状态**：Preview 不增加缓存表、preview token、临时文件生命周期。

---

# P0：后端核心闭环

## Canonical model

- [x] 新增统一导入模型 `NovelImportDraft`
  - [x] source：filename / format
  - [x] project：title / description / settings
  - [x] chapters：index / title / summary / content
  - [x] characters
  - [x] glossary
  - [x] unmappedSections
  - [x] warnings

## TXT

- [x] 保持现有 `text_import.ts` 解析行为，降低回归面
- [x] 增加纯函数 `text_adapter.ts`
- [x] TXT → `NovelImportDraft`
- [x] 不改变已有中文 / 英文章标题识别规则

## Markdown

- [x] 支持 `.md` / `.markdown`
- [x] `# 作品名` → `project.title`
- [x] `## 简介` → `project.description`
- [x] `## 创作信息` → Story Bible / import metadata
- [x] `题材：...` → `settings.genre`
- [x] 题材同时拆分 → `settings.story_tags[]`
- [x] `## 第 N 章 ...` → Chapter
- [x] `### 章节概要` → `chapter.summary`
- [x] `### 正文` → `chapter.content`
- [x] `章节概要 / 正文` heading 本身不进入正文
- [x] 未识别 project / chapter 小节保留
- [x] 第一段正文位于 `### 正文` 前时不丢失
- [x] 章节之后出现非章节 `##` 信息时不丢失
- [x] 无章节标题 Markdown 降级为单章并 warning
- [x] 不自动创建文档未明确给出的人物

## Canonical file parser

- [x] 新增 `import_file.ts`
- [x] Preview / Commit 共用 `parseProjectImportFile()`
- [x] 支持 `.txt`
- [x] 支持 `.md`
- [x] 支持 `.markdown`
- [x] 支持 `.json`
- [x] 支持 `.novastory.json`
- [x] unsupported extension → 415
- [x] decode / malformed input → 400
- [x] parser 层不依赖 DB

## Persistence

- [x] `ProjectImportService`
  - [x] Project / Chapter / Character / Glossary 统一创建
  - [x] `chapter.summary` 正确落库
  - [x] Story Bible settings 正确落库
  - [x] source / warnings / unmappedSections → `settings.import_info`
  - [x] SQLite transaction
  - [x] 失败 rollback

- [x] 抽离 `novastory_json_import.ts`
  - [x] 保留项目 title / description / settings
  - [x] 保留 chapters
  - [x] 保留 characters / visual tags
  - [x] 保留 scenes / shot spec
  - [x] 保留 coverage groups
  - [x] 保留 coverage shots
  - [ ] 完整 character/scene version-history backup/restore（独立任务，不属于本轮 manuscript import）

## Route 收敛

- [x] 新增 canonical `POST /api/projects/import/preview`
- [x] 新增 canonical `POST /api/projects/import/commit`
- [x] input/parser error 与 persistence error 分离
- [x] Dashboard 主链路改用 canonical preview + commit
- [~] legacy `POST /api/projects/import`
  - [x] 保持 TXT / Markdown 向后兼容
  - [x] 原有 JSON restore 行为暂不破坏
  - [ ] 后续让 legacy route 委托 canonical service，删除重复 inline JSON restore
  - [ ] 完成迁移后考虑 deprecate legacy endpoint

---

# P0：测试

## 已编写

- [x] Markdown parser 单元测试
- [x] 《失声的梦核游乐园》10 章结构 regression fixture
  - [x] title
  - [x] description
  - [x] chapters.length = 10
  - [x] chapter title
  - [x] chapter.summary
  - [x] chapter.content
  - [x] content 不含结构 heading
  - [x] genre
  - [x] story_tags
  - [x] characters.length = 0
- [x] unknown chapter section preservation
- [x] trailing project section preservation
- [x] chapter preamble preservation
- [x] single-chapter fallback
- [x] Preview HTTP test
- [x] Preview empty file → 400
- [x] Preview unsupported file → 415
- [x] Commit Markdown → DB persistence test
- [x] Commit unsupported file → 415
- [x] Canonical JSON commit → Chapter / Scene / Coverage restore test
- [x] 实际上传文档人工结构规则检查：10/10 章

## 尚需实际执行

- [ ] `cd backend && npm run check`
- [ ] 根目录 `npm run typecheck`
- [ ] 根目录 `npm run build`
- [ ] 现有 `text_import.test.ts` 实际运行无回归
- [ ] 现有 export/import roundtrip test 实际运行无回归

---

# P1：Import Preview

## Backend

- [x] `POST /api/projects/import/preview`
- [x] 只解析，不写数据库
- [x] 无 preview token / temp file / cache table
- [x] 返回 source + mode
- [x] 返回 project title / description / settings
- [x] 返回章节标题列表
- [x] 返回 chapter summary/content 可用状态
- [x] 返回章节 / 概要 / 正文 / 人物数量
- [x] 返回 JSON 项目的 scene / coverage / shot 数量
- [x] 返回 warnings
- [x] 返回 unmappedSections

## Dashboard

- [x] 选择文件
- [x] 第一步：解析预览
- [x] 展示作品名
- [x] 展示格式与 manuscript / backup 类型
- [x] 展示简介
- [x] 展示 genre / story tags
- [x] 展示章节 / 概要 / 正文 / 人物计数
- [x] 展示前 12 个章节结构
- [x] 展示 warning
- [x] 展示未映射小节数量
- [x] 文件变化自动清空旧 preview
- [x] 第二步：用户确认后 Commit
- [x] commit 成功后创建新项目并关闭弹窗

---

# P1：Story Bible 映射

## 已支持保存

- [x] genre
- [x] style
- [x] main_plot
- [x] character_relations
- [x] story_tags
- [x] pov
- [x] tone
- [x] import_metadata
- [x] import_info
- [x] 不为未知字段增加数据库 column
- [x] `ProjectSettings` 保持 future-key 兼容

## AI Context 接入

现有 `LayeredContext` 已消费：

- [x] genre
- [x] style
- [x] main_plot
- [x] character_relations

新增 metadata 当前已保存、但还未进入写作上下文：

- [ ] pov
- [ ] tone
- [ ] story_tags

实现原则：扩展 `ProjectBible / worldBible` schema，单独表示 POV / Tone / Tags；**不要**把它们粗暴拼进 `style`。

---

# P1.5：Native backup fidelity（独立于小说文稿导入）

- [ ] 评估 `.novastory.json` format v2
- [ ] 导出 / 恢复 `chapter.condensed_content`
- [ ] 导出 / 恢复 `character_version`
- [ ] 导出 / 恢复 `scene_version`
- [ ] 恢复 active_version 时验证对应 version 存在
- [ ] 增加 v1 → v2 compatibility tests

> 该部分不是当前“附加小说文档 → 新小说项目”的阻塞项。

---

# P2：附加文档 / 已有项目扩展

- [ ] 设计“添加到已有小说”模式
- [ ] 评估新增 `project_document`
  - [ ] primary_manuscript
  - [ ] outline
  - [ ] worldbuilding
  - [ ] character_notes
  - [ ] reference
  - [ ] other
- [ ] 设计冲突策略
  - [ ] append
  - [ ] replace
  - [ ] merge
  - [ ] preview-only
- [ ] 文档级 checksum / duplicate detection
- [ ] 接入 Layered Context 时按文档类型选择性注入
- [ ] 避免所有附加资料无差别塞入 prompt

---

# P2：更多格式

- [ ] DOCX
- [ ] EPUB
- [ ] PDF 暂不作为小说工程主文稿导入；未来若支持，定位为 reference document

---

# 明确不做

本轮不引入：

- 向量数据库 / RAG
- PDF OCR
- AI 自动脑补人物
- AI 自动补全世界观
- 独立 Novel 数据表体系
- 为每个 metadata 增加数据库字段
- Preview 临时数据库表
- Preview token / server-side temp-file session
- 一次性完成已有项目复杂自动 merge

---

# 当前完成定义

功能实现层面，以下主链已经成立：

```text
Markdown / TXT
  → Preview
  → Canonical Parser
  → NovelImportDraft
  → 用户确认
  → Commit
  → ProjectImportService
  → SQLite Transaction
  → Project + Chapters + summary + content + Story Bible
```

`.novastory.json` 则走：

```text
NovaStory JSON
  → Preview existing project structure
  → 用户确认
  → Canonical Commit
  → NovaStory JSON Restore Service
  → Project + Chapter + Character + Scene + Coverage
```

## 合入前必须完成

1. `cd backend && npm run check`
2. 根目录 `npm run typecheck`
3. 根目录 `npm run build`
4. 现有 TXT / export-import roundtrip 测试无回归
5. 新增 Markdown / Preview / Commit tests 全部通过
6. 静态检查 PR diff 只包含 import 相关变更

完成以上验证后，再将 Draft PR 标记 Ready for Review。
