---
title: best_practice_scene_visual_prompt
category: best_practice
status: current
sprint: 0827-visual-prompt-compiler
related:
  - "[[0_TASKLIST]]"
  - "[[2_ARCHITECTURE]]"
  - questionlist/0827.md
---

# 分镜 → Pony 提示词编译规范

本文件是 visual_prompt / negative_prompt 规则的**唯一事实源**。实现代码应对齐这里，不要在 `prompts.ts` 另写互相漂移的清单。

## 1. 问题阶级（不要当成「这一本故事」的特例）

正文具象、画面抽象，属于这一类故障，而不是某一章写得太虚：

1. **共享前缀抢 CLIP 前段** — 每镜以相同质量词 + 项目世界观开头，独特道具被挤到后窗。
2. **LLM 直接写最终生图散文** — 文学修辞、声音、气味、心理原样进 Pony。
3. **整章一次重写 + 旧 prompt 当输入** — 最低成本是复制上一镜。
4. **镜头合同塌缩** — 几乎全是 Wide Environmental Action Shot，关键道具没有 Insert。
5. **角色锁被系统提示覆盖** — 圣经是小兽，rewrite 写死 kitten。
6. **负向词只锁物种** — 挡不住航拍、真云、飞船、机甲头、灰棚。

对照实例（项目「失声的梦核游乐园」）：第 2 章 scene 108–113 六条 visual_prompt **完全相同**，而正文已从路灯推进到导览图按钮。第 1 章未走该 rewrite 前缀，词序是正确形态。

## 2. 管道

```text
Chapter.content + Character.visual_tags
        │
        ▼
Beat / Shot Contract     ← 唯一允许 LLM 填写的层（中文可）
        │
        ▼
compilePonyPrompt()      ← 纯函数，产出正向词
        │
        ▼
sanitizer                ← 删非视觉、落地隐喻、砍概念过载
        │
        ▼
uniqueness gate          ← 与上一镜 Jaccard / uniqueness_key
        │
        ▼
negative compiler        ← identity + shot + location + prop
        │
        ▼
scene.visual_prompt + scene.negative_prompt + scene.shot_spec
        │
        ▼
generation_service       ← 只追加 style/quality suffix，不再前置地点模板
```

LLM 可以填契约，不可以输出「Detailed English scene description」当作最终 visual_prompt。

## 3. Shot Contract

每镜只允许这些字段（写入 `scene.shot_spec`）：

| 字段 | 规则 |
|---|---|
| location | 可画名词。禁止情绪/气氛名词。 |
| primary_subject | 角色锁定串，或 `none` / `paw-only`。 |
| primary_action | 一个可见动词。 |
| key_props | 最多 2 个。 |
| shot_intent | 枚举，见下表。 |
| subject_scale | `absent` / `small-15-20` / `medium-20-40` / `dominant` |
| uniqueness_key | `location + action + primary_prop` |
| must_not | 本镜明确不画的东西 |

声音、气味、心理、隐喻解释留给 `narration` / `audio_prompt`。

### 3.1 shot_intent

| intent | 画面合同 | 禁止同镜 |
|---|---|---|
| establish | 地点 + ≥3 环境锚点；角色 absent 或 ≤20% | 微距道具、五官 |
| wide-action | 角色与**一个**道具互动，环境可识别 | 园区全景 + 微观齿轮 |
| medium-action | 腰/膝以上可读动作 | 棚拍白底 |
| insert | 只有道具或爪/鼻；环境当虚化背景 | 全身、天空、航拍 |
| reaction | 半身或侧脸，地点仍可见 | 证件照、looking at viewer 棚拍 |
| overhead-map | 空间关系 / 地图感 | 五官特写 |
| payoff | **一个**状态变化（卡入、灯亮） | 五个复苏事件同时发生 |

### 3.2 章节配额（生成器强制，不靠模型自觉）

- establish + wide-action ≥ 35%
- insert + reaction（近）≤ 20%
- 本章有可识别关键道具时，至少 1 个 insert
- 相邻两镜 uniqueness_key 不得相同
- 相邻 visual_prompt token Jaccard ≥ 0.65 → 拒绝该镜

`shot_type` 对外仍用现有字符串（Wide Shot / Insert Shot / Overhead Shot…），但必须能映射到上表。禁止把一章 90% 写成 `Wide Environmental Action Shot`。

## 4. CLIP 词序（正向）

Pony CLIP 前窗权重大。编译顺序固定：

```text
1. 镜头合同    insert shot, macro, object focus
2. 当镜独特主体（可加权）  (paw pressing a music-note button on a miniature park map:1.4)
3. 地点 2–3 锚  european arcade, mosaic floor, dark metal lamp post in background
4. 角色锁（若可见）  one small beige-and-white furry creature, quadruped, pointed ears, amber eyes
5. 材质/光     cold tile, dim ceiling lamps
6. 质量 suffix  score_9, score_8_up, source_anime   ← 仅生图组装时追加，不入库
```

规则：

- 独特内容在前，质量词在后。
- 同时加权主体不得超过 1 个；权重建议 1.3–1.45，禁止一镜五个 `(x:1.4)`。
- 概念预算：1 主体 + 1 动作 + ≤3 名词锚点。
- 八音盒微距就不要园区倒影；园区复苏全景就不要齿轮齿面。超预算则拆镜，不塞进同一 prompt。
- 项目风格词（dreamcore amusement park、古风仙侠）来自 Project `default_style` / `buildPromptEnhancement` suffix，不写进 compiler 前缀。

## 5. 角色锁

```text
characterLock = Character.visual_tags.base_model.tags
                + 当前章节 variant（timeline_map）
                + 仅本镜的瞬态（湿毛、抱着八音盒）
```

- Base：物种、毛色、耳、眼、体型。跨章稳定。
- Variant：换装/换外形才新建。本项目小兽无换装则一直 Default。
- 瞬态：伤口、手里的道具 — 只进当前镜，不写回角色卡。

系统提示、rewrite、compiler **都不得发明**与圣经冲突的物种词（`kitten`、`1girl`、`wolf`）。圣经没有的外貌，留空，不要补全成家猫。

## 6. Sanitizer

### 6.1 直接删除（非视觉）

从 visual_prompt 去掉（大小写不敏感，匹配后整 token 删除）：

```text
environmental storytelling
narrative comic panel
story action
atmospheric depth
cinematic storyboard
narrative scene
silent atmosphere          ← 「无声」不是可画物；地点用 empty / motionless flags
```

模式删除：

- 听觉：`sound`, `echo`, `ring`, `creak`, `scraping sound`, `music playing`（Melody 作为**可见**音符/音梳保留）
- 嗅觉：`scent`, `smell`, `aroma`, `fragrance`
- 纯心理：`loneliness`, `emptiness in the heart`, `determination` 作抽象名词时
- 元叙事：`storytelling`, `comic panel`, `story continuity`

这些内容若仍需要，放进 `audio_prompt` 或 `narration`。

### 6.2 隐喻必须落地（禁止原词）

| 禁用原词 | 编译为 | 同时写入负向 |
|---|---|---|
| cloud-like platform / cloud platform（未声明是道具） | hard candy-floss spectator platform shaped like a cloud, flat walkable floor, pastel park lighting | real clouds, mountains, blue sky vista, outdoor nature |
| metallic ring echo | concentric ripples on a rigid glass-like ice pool（仅当正文是点水） | abstract metal scales, macro texture only |
| dreamcore（作为每镜前缀） | 删除；由 style preset 承担 | — |
| purple-gold light spreading（无载体） | light traveling along engraved metal grooves / lamp bulbs lighting up | mecha, helmet, spaceship, energy explosion sky |

未在表中的 `X-like` / `as if`：丢掉修辞，保留可画的实体名词。

### 6.3 入库禁词

新写入的 `visual_prompt` 不得包含：

```text
score_9
score_8_up
narrative comic panel
environmental storytelling
detailed dreamcore amusement park environment
```

`score_9, score_8_up, source_anime` 只允许 `generation_service` / `buildPromptEnhancement` 放在 suffix。

**最终 CLIP 正词顺序（生图组装）**：`scene（当镜契约编译结果） → framing（通用构图 / cinematic shot） → quality（score_* / source_anime，各恰好一次）`。禁止质量词或共享构图词占用 CLIP 前窗。

Coverage 候选也必须走 `compilePonyPrompt` / `compileNegativePrompt`；禁止直接入库 LLM 散文或空 visual。

## 7. Negative compiler

```text
negative = identity_lock
         + shot_inverse
         + location_inverse
         + prop_inverse
         + 全局质量负向（bad anatomy, extra limbs, text, watermark, child, loli, shota）
```

**identity_mode**

| mode | 行为 |
|---|---|
| `human` | 不加 human 系负向 |
| `nonhuman` | 仅通用排除：`human, person, man, woman, girl, boy, humanoid, 2animals, duplicate animal`。**不要**把 `wolf/fox/dog` 放进全局常量 |
| `mixed` | 人+动物同镜：不加身份锁；物种偏差用 `must_not` / 项目负向 |
| `unknown` / `auto` 无法判定 | **中性**：不加身份锁（不得默认 nonhuman） |

错误物种（wolf/fox/dog 等）由角色/项目 `must_not` 显式提供。人设主角项目不要把 human 放进负向。

**shot_inverse**

| intent | 加入负向 | 不要加入 |
|---|---|---|
| insert | full body, animal portrait, landscape, aerial, satellite photo, plain background, studio backdrop | — |
| establish / wide-action | close-up face, studio portrait, looking at viewer, plain background, simple background | `simple background` 已列在禁止侧，wide **不得**再靠它抽空背景 |
| reaction | front-facing studio portrait, looking at viewer, ID photo, plain background | 光秃的 `portrait`（会压制动物） |
| payoff | mecha, helmet, spaceship, satellite, abstract explosion | — |

**location_inverse**

| 地点类型 | 加入负向 |
|---|---|
| 室内廊 / 机房 / 座舱 | mountains, real sky vista, farmland, satellite photo, outdoor nature |
| 云朵看台（道具） | real clouds, mountains, aerial landscape |
| 广场建立镜 | indoor studio, empty void |

**prop_inverse**

| 道具 | 加入负向 |
|---|---|
| music box / gears / core / mechanism | mecha, robot head, helmet, vehicle, spaceship |
| miniature map / button | full park aerial, extra panels, text captions |
| ice pool / glass water | metal scales, snake skin, abstract texture close-up（当 intent 不是 insert-texture） |

禁止整章复制同一串负向词。

## 8. 黄金用例（必须写成单测）

输入是契约，不是章节全文。断言针对 compiler 输出。

### G1 导览图音符按钮（对应 0827 第 2 章丢失的动作）

契约：insert；prop = miniature park map + music-note button；action = paw presses button。

必须：`music-note` 或 `button`，以及 `map` 或 `guide`；`insert`。  
禁止：以 corridor / lamp post 作为第一主体；`kitten`（若圣经是 furry creature）；`environmental storytelling`。

### G2 云朵看台 + 木马（对应第 3 章真云群山）

契约：establish；props = carved carousel horses, candy-floss cloud-shaped platforms。

必须：carousel / wooden horses；platform；落地后的 cloud-shaped **平台**。  
禁止：未落地的 `cloud-like`；输出不得依赖「真云」作为地点。  
负向必须含 `mountains` 与 `real clouds`（或 `outdoor nature`）。

### G3 爪尖点冰池（对应第 5 章金属鳞片）

契约：insert 或 wide-action；action = claw taps rigid glass-like ice；visible = ripples。

禁止：`echo` / `ring` / `scent`。  
负向在 insert 时含 `abstract` 或 `scales` 或 `macro texture` 一类。

### G4 红绒椅八音盒（对应第 8 章卫星航拍）

契约：insert；prop = miniature brass music box on red velvet。

必须：music box；velvet。  
禁止：farmland / satellite / aerial park 作为正向主体。  
负向必须含 `aerial` 或 `satellite`，以及 `spaceship` 或 `mecha`。

### G5 核心卡入凹槽（对应第 10 章机甲头）

契约：payoff；action = core seats into engraved groove。

必须：core 或 music box；groove 或 slot 或 socket。  
负向必须含 `mecha` 或 `helmet`。  
禁止：一镜同时枚举 flags + rides + water + lights 五件复苏事件（超概念预算则只保留「灯沿凹槽点亮」或拆下一镜）。

### G6 复制门

给定六条相同的走廊小猫 prompt，uniqueness gate 必须判定失败。

## 9. generation_service 配合

- `inferStyleShotMode` / `buildPromptEnhancement` 读取 `shot_intent`（或 shot_type 映射），Insert 不得叠加 `environment-dominant cinematic composition`。
- 角色 appearance snippet 仍由 `selectSceneCharacterAppearance` 合并；compiler 已写入锁定串时不要再追加冲突物种。
- style LoRA 在 environment/insert 上保持现有减弱/跳过策略，不要为了「更梦幻」把 Detail LoRA 加回去抢构图。

## 10. 存量数据

重编译已有 Timeline：

1. 不要 `POST /timeline/generate` 打散已有镜序（除非主人确认 Timeline 本身作废）。
2. 从 Chapter.content + Character 重建契约，或从 narration/dialogue + 正文对齐后编译。
3. `createSceneVersion`，保留旧 asset。
4. 禁止把旧 visual_prompt 当作 LLM few-shot。
5. 第 1 章若已是加权主体在前、含 Insert 的形态，默认跳过。
