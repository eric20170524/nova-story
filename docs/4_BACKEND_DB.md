# 4_BACKEND_DB.md: 数据与后端规范

## 1. 认证与部署模型

本地单用户应用。监听默认 `127.0.0.1`；CORS 限 localhost；`GET /settings` 脱敏，不回传明文 API Key。

不要在本 Sprint 引入 JWT / `Depends(get_current_user)` / 多租户 RLS。

## 2. 数据库与迁移

- 引擎：SQLite（`backend/sql_app.db`，可用 `DATABASE_URL`）。
- **唯一迁移入口：** `backend/src/db/database.ts` 的 `migrations` 数组。禁止手改表结构、禁止在 route handler 里 `CREATE TABLE`。
- 加列优先 `ensureColumns` 兼容旧库。
- 主键：chapter 用 UUID 字符串；scene / character / project 用整数自增（已有约定，不要混用）。

本 Sprint **优先把镜头契约写入已有 `scene.shot_spec` TEXT（JSON）**。没有按字段查询的需求就不要新迁移。

## 3. 数据隔离

- 角色 / 章节：`project_id`
- 场景：`chapter_id` → chapter.project_id
- 任何列表查询必须带这些键，禁止扫全表当「当前故事」

`project.user_id` 列是遗留兼容，不是本 Sprint 的租户模型。

## 4. 日志

- 实现：`backend/src/core/logging.ts`（pino）
- 文件：`backend/logs/novastory.log`
- 级别：INFO 常规、ERROR 异常、DEBUG 本地
- 禁止把 API Key、参考图绝对路径里的密钥写入日志
- 禁止 `catch` 后吞掉错误

## 5. 测试数据与隔离

- 单测使用 `process.env.DATABASE_URL = ':memory:'` 或测试专用文件，禁止写开发库 `sql_app.db` 作为测试夹具。
- **禁止**用本 Sprint 测试去 `DELETE FROM scene` 用户项目「失声的梦核游乐园」，除非 Phase 3 且主人确认。
- Phase 3 重编译必须 `createSceneVersion`，保留旧 version + asset。

## 6. 与 Prompt 管道相关的 Scene 字段

| 字段 | 职责 |
|---|---|
| visual_prompt | 编译后的 Pony 正向词（无 score_9 前缀） |
| negative_prompt | 按契约编译的负向词 |
| shot_type / camera_angle / camera_movement | 镜头合同的对外字段 |
| shot_spec | 结构化契约（intent、location、action、key_props、uniqueness_key） |
| dialogue / narration | 字幕；**禁止**把声音/心理写进 visual_prompt |
| audio_prompt | 声音、音乐；消毒器删掉的听觉词应落这里而不是画面 |
| asset_url / asset_status / active_version | 生图与 A/B |

时间线替换、coverage 提升、项目/章节删除必须在事务里进行（现有 `BEGIN IMMEDIATE` 模式）。
