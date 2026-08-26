# NovaStory 已有小说附加资料 TODO

创建：2026-08-26

## 目标

在已有小说项目中安全添加补充资料，并让用户决定哪些资料参与 AI 写作上下文。

本功能与“文稿导入为新 Project”分离：附加资料不是 Chapter，也不是 Story Bible 字段，不会因为上传而自动覆盖任何既有创作数据。

---

## 核心原则

- **非破坏性**：上传/删除附加资料不修改 Chapter 正文、Chapter summary 或 Story Bible。
- **显式启用**：新资料 `context_enabled = 0`；只有用户手动开启才进入 AI 上下文。
- **预算优先**：启用不等于全文注入；每类文档有单文档上限，总上下文上限 1600 字符。
- **确定性来源**：保存的是用户原始 TXT / Markdown 内容，不用 AI 自动脑补或改写。
- **去重**：按规范化正文 SHA-256，在同一 Project 内阻止重复导入。
- **可追踪**：保留 filename / format / mime / checksum / 文档类型 / 统计元数据。
- **类型化上下文**：大纲、世界观、人物笔记、参考资料、其他有明确优先级，不把所有资料无差别塞入 prompt。

---

## 数据模型

### `project_document`

- [x] id
- [x] project_id + FK cascade
- [x] name
- [x] document_type
- [x] source_filename
- [x] source_format
- [x] mime_type
- [x] content
- [x] checksum
- [x] metadata_json
- [x] context_enabled，默认 0
- [x] created_at / updated_at
- [x] UNIQUE(project_id, checksum)
- [x] project/type 索引
- [x] context_enabled 索引

迁移：

- [x] `008_project_documents`
- [x] `009_project_document_context`
- [x] legacy schema upgrade 回归覆盖

---

## 文档类型

- [x] `outline`：大纲
- [x] `worldbuilding`：世界观
- [x] `character_notes`：人物笔记
- [x] `reference`：参考资料
- [x] `other`：其他

暂不把 `primary_manuscript` 放入该表的用户流程；主文稿继续由 Chapter 模型承担。

---

## P0：解析与存储

- [x] TXT
- [x] Markdown
- [x] UTF-8 / GBK / GB18030 复用现有 decoder
- [x] 空文件拒绝
- [x] 其他格式 415
- [x] Markdown H1 作为默认资料名
- [x] 文件名 fallback
- [x] SHA-256 checksum
- [x] 字符数 / 行数 / Markdown heading 数统计
- [x] 同 Project 重复资料 Preview 可见
- [x] 同 Project 重复 Commit → 409
- [x] 数据库 UNIQUE 兜底并映射竞态重复为 409

---

## P0：API

- [x] `GET /api/projects/:id/documents`
- [x] `POST /api/projects/:id/documents/preview?document_type=...`
- [x] `POST /api/projects/:id/documents?document_type=...`
- [x] `PATCH /api/projects/:id/documents/:documentId`
  - [x] `context_enabled: boolean`
- [x] `DELETE /api/projects/:id/documents/:documentId`
- [x] List/Delete 不返回原始 content，避免无必要的大 payload
- [x] Project / Document 404 边界

---

## P0：安全不变量

- [x] Preview 不写数据库
- [x] Commit 不改既有 Chapter content
- [x] Commit 不改既有 Chapter summary
- [x] Commit 不改 Project Story Bible settings
- [x] 新资料默认不进入 AI Context
- [x] 删除资料只删除 `project_document`
- [x] Project 删除由 FK cascade 清理附加资料

---

## P1：前端

项目任意页面提供“附加资料”入口：

- [x] 打开项目资料面板
- [x] 选择资料类型
- [x] 选择 TXT / Markdown
- [x] 解析预览
- [x] 展示标题、格式、字符数、行数、heading 数
- [x] 明确提示不会覆盖正文 / Story Bible
- [x] 重复资料提示并禁止重复 Commit
- [x] 确认添加
- [x] 已添加资料列表
- [x] 删除
- [x] AI 上下文显式开启/关闭
- [x] 开启状态在列表中可见

---

## P1：AI Context

### 选择规则

只有：

```sql
project_id = currentProject
AND context_enabled = 1
```

的资料可以进入写作上下文。

优先级：

1. outline
2. worldbuilding
3. character_notes
4. reference
5. other

限制：

- [x] 最多读取 8 个启用文档
- [x] 总预算 1600 字符
- [x] outline 单文档最多 700
- [x] worldbuilding 最多 600
- [x] character_notes 最多 550
- [x] reference 最多 400
- [x] other 最多 300
- [x] 文档带类型 + 名称 header，避免来源混淆

### 写作接入

- [x] `loadWritingBundle()` 加载启用资料
- [x] 主章节生成加入 `[补充资料]` block
- [x] 创作约束 / 补充资料 / 章节记忆并存
- [x] CINEMATIC_REWRITE / ADD_CONFLICT / REVERSE_PLOT skill context 使用同一启用资料
- [x] 关闭资料不会出现在最终写作 prompt

---

## 测试

- [x] 完整 Preview → Commit → List → Delete
- [x] 默认 context_enabled = 0
- [x] PATCH enable / disable
- [x] enabled context 可读取
- [x] disabled context 不可读取
- [x] context 总预算测试
- [x] 单文档预算测试
- [x] duplicate preview
- [x] duplicate commit 409
- [x] Chapter / Story Bible 非破坏性断言
- [x] List/Delete 不返回 content
- [x] Migration 008 / 009
- [x] 最终 WritingService prompt 只包含显式启用资料
- [ ] 当前分支最终 CI 全绿

---

## 后续 P2

### 文档管理

- [ ] 重命名资料
- [ ] 修改 document_type
- [ ] 查看原文
- [ ] 替换文档并重新计算 checksum
- [ ] 排序/置顶（仅在实际需要时增加）

### 更精确上下文

当前采用“显式启用 + 小预算直接截取”，用于保持架构最小。

后续只有在资料量真实增长后才评估：

- [ ] 按当前章节/任务选择相关文档
- [ ] 文档 section 级选择，而不是整篇截取
- [ ] 关键词 / FTS5 检索
- [ ] 最后才评估 embedding / vector RAG

不提前引入向量数据库。

### 更多格式

- [ ] DOCX
- [ ] EPUB
- [ ] PDF 仅作为 reference 候选，不作为主文稿首选

---

## 完成定义

```text
已有 Project
  → 添加 TXT / Markdown 补充资料
  → Preview
  → checksum 去重
  → project_document（默认 context_enabled = 0）
  → 用户显式开启 AI Context
  → 类型优先级 + 单文档预算 + 总预算
  → WritingService [补充资料]
  → AI 写作 / 技能重写
```

整个链路不能自动修改已有正文、章节概要或 Story Bible。
