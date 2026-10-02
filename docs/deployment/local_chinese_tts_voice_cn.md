# 本机中文 TTS 与角色音色

> 任务事实源：`docs/0_TASKLIST.md` Track 6。本文只规定「连通 local-chinese-tts、查询并试听音色、在资产管理的角色上保存音色」。章节对白配音、视频混音、克隆上传不在本阶段。
>
> 核对日期：2026-10-02。服务实现以 `/Users/lm/pyProj/local-chinese-tts/local_tts.py` 为准。

## 1. 目标

NovaStory 把本机 [local-chinese-tts](file:///Users/lm/pyProj/local-chinese-tts) 当作独立进程。作者可以看见当前机器上的全部音色（轻量、高质、克隆、在线），试听一条短句，并把选中的音色编号记在项目角色上。服务关掉之后，已经保存的角色音色仍显示，角色的名字和形象保存不受影响。

## 2. 已核对的服务事实

服务默认只听 `http://127.0.0.1:8765`，没有 CORS，也没有鉴权。2026-10-02 本机实测：

| 检查 | 结果 |
| --- | --- |
| `GET /api/health` | `ok: true`，`voices: 30`，`default_voice: "QF1"`，`local_models` 的 light / quality / clone 均为 true |
| `GET /api/voices` | `voices.length === 32`，`selected: "QF1"` |
| 分档 | light 4、quality 13、online 13、clone 2 |

`health.voices` 只数内置的 K/Q/F/M，**不含克隆**。目录长度以 `GET /api/voices` 的 `voices.length` 为准。当前克隆包括 `C_1785664414_d700a8`（陆雪琪）和 `C_test_123456`（测试音色）。克隆条目带本机绝对路径 `ref_audio`。

合成相关接口：

| 方法 | 路径 | NovaStory 的用法 |
| --- | --- | --- |
| GET | `/api/health` | 连通探测 |
| GET | `/api/voices` | 唯一目录来源，已包含克隆 |
| POST | `/v1/audio/speech` | 试听。请求体 `{ model, input, voice, speed, response_format }`，响应是音频字节 |
| POST | `/api/tts` | 本阶段不使用。它返回 `/audio/...`，文件在 TTS 的 `cache/`，安装任务会删掉超过 3 天的缓存 |
| POST | `/api/settings` | 本阶段不调用。它改的是 TTS 进程自己的默认音色，并同步 macOS「中文音色朗读」；克隆编号还会被拒绝 |
| POST/DELETE | `/api/voices/clone` | 克隆的上传和删除留在 TTS 控制面板 `http://127.0.0.1:8765/` |

其他约束：单次文本最多 5000 字；`speed` 为 0.5–2.0；MLX 合成在服务内串行；高质与克隆模型按需加载，README 记录的峰值约 5.8GB 统一内存。在线 F/M 首次合成需要网络。音色的公开编号是 `id`（`K01`、`QF1`、`C_1785664414_d700a8`）。引擎字段 `voice` 会重复（多个高质预设共用 `Vivian`），不能当作编号。

## 3. 本阶段交付

1. 后端可配置 TTS 根地址，默认 `http://127.0.0.1:8765`。
2. `GET /api/tts/status` 与 `GET /api/tts/voices` 把目录变成稳定、可给浏览器的结构。
3. `POST /api/tts/preview` 用指定编号合成一条最多 80 字的试听，并把 mp3 流转回浏览器。
4. 角色增加 `voice_id` 与 `voice_label`。资产管理里的角色编辑可以查询、筛选、试听、选定和清除。
5. 项目导出、回导和复制带着这两个字段。从正文提取角色时保留已有音色。

角色卡、`/project/:id/assets` 的角色页、`/characters` 共用 `CharacterManager`，只改这一处界面。

## 4. 连通方式

浏览器只访问 NovaStory。Fastify 再访问 TTS。这样绕开 TTS 没有 CORS 的限制，也避免把 `ref_audio` 绝对路径送到前端。

```text
角色编辑弹窗
  → GET /api/tts/voices
  → Fastify 校验根地址、请求 127.0.0.1:8765/api/voices、删掉本机路径
  → 作者选定 id
  → PUT /api/characters/:id  { voice_id }
  → 服务端对照当场拉到的目录写 voice_id + voice_label

试听
  → POST /api/tts/preview { voice_id, text? }
  → Fastify POST /v1/audio/speech
  → audio/mpeg 流
```

NovaStory 不读 `cloned_voices.json`，不导入 MLX，不把试听文件写入 `media_asset`、`scene.audio_prompt` 或 `backend/static/`。

目录是 TTS 进程的活数据。SQLite 只保存角色选中的编号和一行展示名，不缓存整份音色表。

## 5. 配置

在 `settings_manager` 增加 `tts`，环境变量写在 `backend/.env`，示例写进 `backend/.env.example`：

```text
TTS_BASE_URL=http://127.0.0.1:8765
```

| 字段 | 规则 |
| --- | --- |
| `tts.base_url` | 默认 `http://127.0.0.1:8765`。`TTS_BASE_URL` 覆盖已保存的值，方式和 `COMFYUI_LOCAL_URL` 相同 |
| 协议 | `http` 或 `https` |
| 主机 | `127.0.0.1`、`localhost`、`::1`。其他主机要同时设置 `TTS_ALLOW_REMOTE=1` |
| 其余 | 拒绝用户名、密码和非空路径 |

非法地址在发起请求前失败，错误码 `TTS_URL_REJECTED`。`tts.enabled === false` 时状态接口返回未启用，角色改绑新音色返回 `TTS_UNAVAILABLE`；清除音色仍然允许。

超时：状态 2 秒，目录 5 秒，试听 120 秒。试听响应体上限 8MiB，超出按上游失败处理。

## 6. NovaStory 接口

### GET /api/tts/status

始终 HTTP 200，方便设置页画状态，不把「TTS 没开」变成 NovaStory 自己的 500。

```json
{
  "ok": true,
  "enabled": true,
  "base_url": "http://127.0.0.1:8765",
  "voice_count": 32,
  "default_voice": "QF1",
  "local_models": { "light": true, "quality": true, "clone": true }
}
```

连不上时 `ok: false`，带 `error`，`voice_count: 0`。`voice_count` 取目录长度，不取 `health.voices`。

### GET /api/tts/voices

成功为 200。连不上为 503，`code: "TTS_UNAVAILABLE"`。

每条只保留：

```json
{
  "id": "QF1",
  "name": "Serena",
  "gender": "女声",
  "style": "高质温柔",
  "locale": "普通话",
  "description": "自然温暖，适合高品质叙述",
  "tier": "quality",
  "offline": true,
  "provider": "local-mlx"
}
```

`tier` 只允许 `light | quality | clone | online`。响应里不出现 `ref_audio`、`ref_text`、`instruct`、`model`、`voice`、`rate`、`pitch`、`resource`，也不出现 `/Users/` 或其他绝对路径。排序：light、quality、clone、online，档内按 `id` 稳定排序。

### POST /api/tts/preview

```json
{ "voice_id": "QF1", "text": "这是这个角色的声音。" }
```

| 情况 | 结果 |
| --- | --- |
| 省略 `text` | 使用「这是这个角色的声音。」 |
| `text` 去空白后为空，或超过 80 个字符 | 400，整段拒绝，不截断后送去合成 |
| `voice_id` 不在当场目录中 | 400，`VOICE_NOT_FOUND` |
| 上游不可达或合成失败 | 503，`TTS_UNAVAILABLE` |
| 超过 120 秒 | 504，`TTS_TIMEOUT` |
| 成功 | `Content-Type: audio/mpeg`，body 为 mp3 |

上游请求固定 `model: "local-chinese-tts"`、`speed: 1`、`response_format: "mp3"`，`voice` 用公开 `id`。试听不写数据库。

角色接口继续用现有 `POST /api/characters/` 与 `PUT /api/characters/:id`。错误体与现有角色路由一致：`{ "detail": "...", "code": "VOICE_NOT_FOUND" }`。

## 7. 角色上的音色

迁移 `018_character_voice`，只用 `ensureColumns`：

```text
character.voice_id     TEXT NULL
character.voice_label  TEXT NULL
```

`voice_id` 是 TTS 的公开 `id`。`voice_label` 由服务端在绑定时写成 `` `${id} · ${name} · ${style}` ``，最长 120 字符。客户端传来的 `voice_label` 丢弃。

这两个字段与形象版本分开：

- `visual_tags` 继续只放生图用的外观、变体和立绘资源。
- `character_version` 继续只快照 `description` 与 `visual_tags`。
- 现有 `PUT` 仍会重写 `visual_tags` 并 `syncActiveCharacterVersion`。音色列不进入那份快照。
- 生图提示词组装不读取 `voice_id` / `voice_label`。

未设定的角色保持 `NULL`。不根据角色身份、名字或 TTS 当前默认音色自动填 `K01` / `QF1`。

Zod：`voice_id` 为 `string | null`，可选。非空时匹配 `^[A-Za-z][A-Za-z0-9_]{0,79}$`。空字符串按 `null`。

## 8. 保存规则

`PUT` 今天会被头像、三视图等局部更新调用，body 里常常没有音色。规则按「字段是否出现」区分：

| 请求里的 `voice_id` | 行为 |
| --- | --- |
| 字段省略 | 两列保持原值。不访问 TTS |
| `null` 或 `""` | 两列写成 NULL。不访问 TTS。服务关闭时也允许 |
| 与库里相同的非空编号 | 保持编号和已有 label。不访问 TTS |
| 新的非空编号，且目录里有 | 写入该编号，并用目录字段重写 label |
| 新的非空编号，目录里没有 | 400 `VOICE_NOT_FOUND`，本次 PUT 不写任何列 |
| 新的非空编号，TTS 不可达或已禁用 | 503 `TTS_UNAVAILABLE`，本次 PUT 不写任何列 |

校验放在 `UPDATE` 之前。创建角色时省略 `voice_id` 则两列为 NULL；带了新编号就用同一套校验。

目录里后来消失的克隆保持已保存的编号和 label。界面说明「本机目录中已没有这个音色」，并提供清除。重新打开 TTS 或克隆还在时，绑定继续有效。

## 9. 备份、复制与提取

导出仍是 `novastory-project` version 2。角色对象增加可选的 `voice_id`、`voice_label`。旧文件没有这两字段时导入为 NULL。

必须带着这两列的写入：

- `backend/src/routes/projects.ts` 的项目复制 `INSERT INTO character`
- `backend/src/services/import/novastory_json_model.ts` 与 `novastory_json_import.ts`

编号是 TTS 的外部 id，复制项目时不重映射。

以下路径新建角色时音色保持 NULL，更新旧角色时不改这两列：

- `POST /api/characters/extract` 里对已有角色的 `UPDATE`（只写 role、description、visual_tags）
- 故事规划、写作服务里按名字插入角色的语句

`project_import.ts` 从纯文本草稿建角色时同样留空。

## 10. 界面

文案进 `locales.ts` 的 `zh` 与 `en`。新控件带 `data-testid`。

### 角色编辑（`CharacterEditModal`）

音色区包含：

- 状态：`character-voice-status`。连通时显示音色数量；未连通时说明暂时不能更换，已保存的 label 仍在。
- 按档筛选后的选择器：`character-voice-select`。分组顺序与接口一致。在线档标明首次合成需要网络；高质和克隆标明首次播放会加载较大模型。
- 试听：`character-voice-preview`。进行中不可再次点击。用返回的 mp3 播放，播完释放 blob URL。失败用现有 toast。
- 清除：`character-voice-clear`，把表单里的 `voice_id` 设为 `null`。
- 保存仍走现有角色保存。保存请求带上 `voice_id`（选中的编号或 `null`）。

选择器以目录为准。已保存的编号不在目录中时，显示 label 和「本机目录中已没有这个音色」，清除仍可用。

### 角色卡（`CharacterCard`）

有 label 时显示 label；没有时显示「未设定音色」。

### 设置页

一块连通状态即可：是否可达、音色数量、TTS 自己的默认音色、当前根地址。这里不放角色音色选择，也不提供「写回 TTS 全局默认音色」的按钮。

窄屏下编辑弹窗保持现有滚动，音色区使用选择器，不展开成大卡片墙。

## 11. 测试

默认 `npm test` 不连接真实 TTS，用假的 HTTP 响应。

| 用例 | 锁住的行为 |
| --- | --- |
| 目录归一 | 去掉 `ref_audio` 等字段；32 条样本得到 32 条公开结构；克隆绝对路径不出现在 JSON 文本中 |
| 状态 | 上游成功时 `voice_count` 用目录长度；连接失败时 HTTP 200 且 `ok: false` |
| 地址守卫 | 非回环且无 `TTS_ALLOW_REMOTE` 时不发起请求 |
| 角色保存 | 省略字段不清空；`null` 清空且不请求上游；相同编号不请求上游；未知编号 400 且行不变；上游失败 503 且行不变 |
| 局部 PUT | `{ avatar_url }` 不改变 `voice_id` |
| 试听 | 成功体为 audio/mpeg；超长文本 400；不插入 `media_asset` |
| 提取 | 已有角色提取后 `voice_id` 仍在 |
| 复制与导入 | 新项目带上原编号；无字段的旧 JSON 得到 NULL |
| 路由基线 | `server.test.ts` 的路由计数加上本任务新注册的路由 |
| 提示词 | 角色生图提示词组装结果不含 `voice_label` |

可选的实机检查用 `TTS_SMOKE=1`，单独跑，不进默认测试。

## 12. 验收时的浏览器路径

1. 打开项目的资产管理 → 角色，或直接打开 `/characters`。两条路由都走同一组件，都要看。
2. 编辑一个角色，筛选到克隆档，能看见「陆雪琪」一类克隆名，选中并试听。
3. 保存后卡片出现 label；刷新后再打开，编号仍在。
4. 清除并保存，卡片变为未设定。
5. 把根地址指到一个没有服务的端口，或停掉 TTS：已保存音色仍显示，改选新音色被拒绝，清除仍可保存。
6. 桌面宽度和约 390px 宽各做一次，弹窗可滚动，选择器和按钮不被裁切。

服务已在本机 8765 运行时，第 2 步用真实试听。停服只用于第 5 步。

## 13. 后续单独开任务

这些能力要等 Track 6 的验收完成后再立项，避免和角色绑音混在同一次改动里：

- 按分镜对白 / 旁白把 `voice_id` 合成可长期保存的音频，并写入 NovaStory 自己的静态目录。
- 把这段音频送进视频成片。
- 在 NovaStory 里上传或删除克隆参考音。
- 项目级旁白音色。
- 由 Agent 代替作者挑选音色。
