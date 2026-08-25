# NovaStory 小说文档导入 TODO

日期：2026-08-25

## 当前状态

分支：`feature/novel-document-import`

首轮实现已经打通 Markdown 文档导入的核心链路：

`Markdown → NovelImportDraft → ProjectImportService → SQLite Transaction → Project / Chapter.summary / Chapter.content`

已使用《失声的梦核游乐园》实际上传文档结构做规则验证：识别 10/10 章，第一章“章节概要 / 正文”边界正确，题材可拆分为 `genre + story_tags`。

注意：仓库当前没有 GitHub Actions 状态检查；本轮已经补充自动化测试代码，但尚不能把“测试已编写”表述为“CI 已实际运行通过”。合入前仍应在正常开发环境执行：

```bash
cd backend
npm run check
```

## 目标

在不重构现有 Project / Chapter / Character / Glossary / Story Bible 数据模型的前提下，把现有“TXT / NovaStory JSON 导入新项目”升级为统一的小说文档导入链路。

首期目标：支持 Markdown 作为一等输入，并正确映射作品级信息、章节概要与正文；文档解析结果先收敛为统一的 `NovelImportDraft`，再由导入服务事务化写入数据库。

> 架构校正：`.novastory.json` 本质是 NovaStory 原生项目备份/恢复格式，包含 Scene / Coverage 等信息，不强制压扁为 manuscript `NovelImportDraft`。TXT / Markdown 等“小说文档格式”统一进入 Draft；原生 JSON 保持 lossless restore 路径，后续只抽离 service，不改变语义。

## 设计原则

- 架构收敛：小说文档格式只负责解析，数据库写入统一走 `ProjectImportService`。
- 原生项目恢复独立：`.novastory.json` 保持完整项目 restore，不与普通 manuscript parser 混为一谈。
- 确定性导入：Importer 只提取源文档明确提供的信息，不自动脑补人物、世界观或设定。
- 最大化复用现有模型：优先复用 `project.description`、`project.settings`、`chapter.summary`、`chapter.content`、`character`、`glossary`。
- 信息不丢失：无法映射的结构保留到 `import_metadata` / `import_info.unmapped_sections`，而不是静默丢弃。
- 原子写入：新项目、章节、人物、术语必须在同一个事务中成功或回滚。
- 可预览：正式导入前应支持 Preview，避免长篇小说被错误拆章后直接落库。

## P0：后端最小闭环

- [x] 新增统一导入模型 `NovelImportDraft`
  - [x] source：filename / format
  - [x] project：title / description / settings
  - [x] chapters：index / title / summary / content
  - [x] characters
  - [x] glossary
  - [x] unmappedSections
  - [x] warnings

- [x] TXT 兼容接入统一 Draft
  - [x] 保持现有 `text_import.ts` 解析行为不变，降低回归面
  - [x] 通过 `draftFromTextProject()` adapter 转为 `NovelImportDraft`
  - [x] 不改变现有中文 / 英文章节标题识别能力

- [x] 新增 Markdown 解析
  - [x] 支持 `.md` / `.markdown`
  - [x] `# 作品名` → `project.title`
  - [x] `## 简介` → `project.description`
  - [x] `## 创作信息` → Story Bible / import metadata
  - [x] `题材：...` → `settings.genre`，同时保留标签数组
  - [x] `## 第 N 章 ...` → Chapter
  - [x] `### 章节概要` → `chapter.summary`
  - [x] `### 正文` → `chapter.content`
  - [x] `章节概要` / `正文` 标题本身不进入正文
  - [x] 未识别的作品级 / 章节级小节保留，不静默丢失
  - [x] 无章节标题 Markdown 降级为单章导入并给出 warning

- [x] 新增统一 `ProjectImportService`
  - [x] Parser 与 DB 写入解耦
  - [x] 统一创建 Project / Chapter / Character / Glossary
  - [x] 统一 JSON settings 序列化
  - [x] 使用现有 SQLite transaction
  - [x] 保证失败完整回滚
  - [x] 持久化 source / warnings / unmappedSections 到 `settings.import_info`

- [~] 收敛 `routes/projects.ts`
  - [x] TXT / Markdown 文档导入只负责格式分派并调用 ImportService
  - [ ] 将原生 NovaStory JSON restore 从 route 抽到独立 service（语义保持不变）
  - [ ] 将 parser error 与 DB persistence error 分开返回，避免 DB 异常被包装为 400

## P0：测试

- [ ] 在正常开发环境执行并通过现有 `text_import.test.ts`
- [x] 新增 Markdown parser 单元测试
- [x] 使用《失声的梦核游乐园》结构作为 10 章回归 fixture（使用结构化最小文本，避免把完整小说正文提交到公开仓库）
  - [x] title = `失声的梦核游乐园`
  - [x] chapters.length = 10
  - [x] 第一章 title 正确
  - [x] 第一章 summary 正确拆分
  - [x] 第一章 content 从正文开始
  - [x] content 不包含 `### 章节概要`
  - [x] content 不包含 `### 正文`
  - [x] project.description = 简介正文
  - [x] genre / story_tags 被保留
  - [x] characters.length = 0（不进行 AI 推断）
- [x] 新增 HTTP 导入回归测试代码
  - [x] `.md` multipart 可导入
  - [x] 项目、章节、summary、content、settings 落库断言
  - [ ] 增加非法 / 空文件 HTTP 回归断言
- [x] 使用实际上传文档做结构规则验证：10/10 章识别正确
- [ ] 执行 `cd backend && npm run check`

## P1：Import Preview

- [ ] 新增 `POST /api/projects/import/preview`
  - [ ] 只解析，不写数据库
  - [ ] 返回 project / chapters / characters / glossary / warnings / unmappedSections

- [ ] Dashboard 导入弹窗升级为两阶段
  - [ ] 选择文件
  - [ ] 解析预览
  - [ ] 显示作品名、章节数、概要数、正文数、人物数、警告
  - [ ] 用户确认后导入为新项目

- [x] 前端文件选择支持
  - [x] `.md`
  - [x] `.markdown`
  - [x] `.txt`
  - [x] `.json`
  - [x] `.novastory.json`

## P1：Story Bible 映射

- [x] 仅映射源文档明确提供的信息
- [x] 支持并保留
  - [x] genre
  - [x] style
  - [x] main_plot
  - [x] character_relations
  - [x] story_tags
  - [x] pov
  - [x] tone
  - [x] import_metadata
  - [x] import_info（来源、warnings、无法映射的小节）
- [x] 不为未知字段新增数据库 column
- [x] `ProjectSettings` 增补类型定义，同时继续允许未知未来字段

## P2：附加文档 / 已有项目扩展

- [ ] 设计“添加到已有小说”模式，但本轮不实现
- [ ] 评估新增 `project_document`
  - [ ] primary_manuscript
  - [ ] outline
  - [ ] worldbuilding
  - [ ] character_notes
  - [ ] reference
  - [ ] other
- [ ] 设计冲突策略：append / replace / merge / preview-only
- [ ] 接入 Layered Context 时按文档类型选择性注入，避免全部塞入上下文

## P2：更多格式

- [ ] DOCX
- [ ] EPUB
- [ ] PDF 暂不作为小说工程导入格式；若未来支持，定位为参考资料导入

## 明确不做

本轮不引入：

- 向量数据库 / RAG
- PDF OCR
- AI 自动脑补人物
- AI 自动补全世界观
- 独立 Novel 数据表体系
- 为每个新 metadata 增加数据库字段
- 一次性实现“已有项目增量合并”全功能

## 首轮完成定义

当以下链路成立，即认为核心 P0 功能完成：

`Markdown 文件 → NovelImportDraft → 校验 → ProjectImportService → SQLite Transaction → Project + Chapters + chapter.summary + chapter.content`

合入条件：

1. `cd backend && npm run check` 实际执行通过；
2. TXT / `.novastory.json` 既有导入测试无回归；
3. Markdown HTTP 导入回归测试通过；
4. 再进入 P1 Preview，避免把“解析正确性”和“大 UI 改造”混在同一个提交阶段。
