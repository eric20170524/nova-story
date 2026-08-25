# NovaStory 小说文档导入 TODO

日期：2026-08-25

## 目标

在不重构现有 Project / Chapter / Character / Glossary / Story Bible 数据模型的前提下，把现有“TXT / NovaStory JSON 导入新项目”升级为统一的小说文档导入链路。

首期目标：支持 Markdown 作为一等输入，并正确映射作品级信息、章节概要与正文；所有解析结果先收敛为统一的 `NovelImportDraft`，再由导入服务事务化写入数据库。

## 设计原则

- 架构收敛：不同文件格式只负责解析，数据库写入统一走 `ProjectImportService`。
- 确定性导入：Importer 只提取源文档明确提供的信息，不自动脑补人物、世界观或设定。
- 最大化复用现有模型：优先复用 `project.description`、`project.settings`、`chapter.summary`、`chapter.content`、`character`、`glossary`。
- 信息不丢失：无法映射的结构保留到 `import_metadata` / `unmappedSections`，而不是静默丢弃。
- 原子写入：新项目、章节、人物、术语必须在同一个事务中成功或回滚。
- 可预览：正式导入前应支持 Preview，避免长篇小说被错误拆章后直接落库。

## P0：后端最小闭环

- [ ] 新增统一导入模型 `NovelImportDraft`
  - [ ] source：filename / format
  - [ ] project：title / description / settings
  - [ ] chapters：index / title / summary / content
  - [ ] characters
  - [ ] glossary
  - [ ] unmappedSections
  - [ ] warnings

- [ ] 重构现有 `text_import.ts`
  - [ ] 保持现有 TXT 兼容行为
  - [ ] 输出统一 `NovelImportDraft`
  - [ ] 不改变现有中文 / 英文章节标题识别能力

- [ ] 新增 Markdown 解析
  - [ ] 支持 `.md` / `.markdown`
  - [ ] `# 作品名` → `project.title`
  - [ ] `## 简介` → `project.description`
  - [ ] `## 创作信息` → Story Bible / import metadata
  - [ ] `题材：...` → `settings.genre`，同时保留标签数组
  - [ ] `## 第 N 章 ...` → Chapter
  - [ ] `### 章节概要` → `chapter.summary`
  - [ ] `### 正文` → `chapter.content`
  - [ ] `章节概要` / `正文` 标题本身不进入正文
  - [ ] 未识别的作品级小节保留，不静默丢失

- [ ] 新增统一 `ProjectImportService`
  - [ ] Parser 与 DB 写入解耦
  - [ ] 统一创建 Project / Chapter / Character / Glossary
  - [ ] 统一 JSON settings 序列化
  - [ ] 使用现有 SQLite transaction
  - [ ] 保证失败完整回滚

- [ ] 收敛 `routes/projects.ts`
  - [ ] `/projects/import` 只负责文件接收、格式分派、调用 ImportService
  - [ ] 不继续在 route 内堆格式解析和逐表写入细节

## P0：测试

- [ ] 保留并通过现有 `text_import.test.ts`
- [ ] 新增 Markdown parser 单元测试
- [ ] 使用《失声的梦核游乐园》结构作为回归 fixture
  - [ ] title = `失声的梦核游乐园`
  - [ ] chapters.length = 10
  - [ ] 第一章 title 正确
  - [ ] 第一章 summary 正确写入
  - [ ] 第一章 content 从正文开始
  - [ ] content 不包含 `### 章节概要`
  - [ ] content 不包含 `### 正文`
  - [ ] project.description = 简介正文
  - [ ] genre / story_tags 被保留
  - [ ] characters.length = 0（不进行 AI 推断）
- [ ] 新增 HTTP 导入回归测试
  - [ ] `.md` multipart 可导入
  - [ ] 项目、章节、summary 正确落库
  - [ ] 非法 / 空文件返回可读错误

## P1：Import Preview

- [ ] 新增 `POST /api/projects/import/preview`
  - [ ] 只解析，不写数据库
  - [ ] 返回 project / chapters / characters / glossary / warnings / unmappedSections

- [ ] Dashboard 导入弹窗升级为两阶段
  - [ ] 选择文件
  - [ ] 解析预览
  - [ ] 显示作品名、章节数、概要数、正文数、人物数、警告
  - [ ] 用户确认后导入为新项目

- [ ] 前端文件选择支持
  - [ ] `.md`
  - [ ] `.markdown`
  - [ ] `.txt`
  - [ ] `.json`
  - [ ] `.novastory.json`

## P1：Story Bible 映射

- [ ] 仅映射源文档明确提供的信息
- [ ] 支持并保留
  - [ ] genre
  - [ ] style
  - [ ] main_plot
  - [ ] character_relations
  - [ ] story_tags
  - [ ] pov
  - [ ] tone
  - [ ] import_metadata
- [ ] 不为未知字段新增数据库 column

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

当以下链路成立，即认为 P0 完成：

`Markdown 文件 → NovelImportDraft → 校验 → ProjectImportService → SQLite Transaction → Project + 10 Chapters + chapter.summary + chapter.content`

并且现有 TXT / `.novastory.json` 导入测试无回归。
