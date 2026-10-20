# 模型出语义、Harness 管协议

弱模型处理分镜事实、人物指代、译文、连续状态和角色资产时，模型只决定语义，Harness 决定协议状态。Agent 决定做什么，Revision Generator 写正文，Harness 负责授权、验证和落盘。模型越弱，越收紧 Harness 的控制面。

整理日期：2026 年 10 月 20 日。对照基线仍是 `60739f46dad8dfb797d8374c7e17324dff8c3c13`，范围从 `ed1e30bb17b819a9796cdd7be41f0a65594ca992` 至该基线。下文 T1–T8 已写入当前代码。历史表保留改之前的现象，用来说明每条协议替换了哪一种改写。

## 状态

| 项 | 结论 |
| --- | --- |
| 方案 | 已整理，见下文 T1–T8 |
| 代码 | 已按本文改完 |
| 实施 | 已落地 |
| 已确认的行为 | 模型把人物下标整组编错、但条数和顺序都对时，只留下未确认建议，不自动改写剧本 |

## 分工

| 角色 | 决定什么 | 例子 |
| --- | --- | --- |
| 模型 | 语义 | 这句里的「她」是谁；这是衣着还是姿势；这句英文在说什么 |
| Harness | 协议 | 下标是不是待解析集合的排列；引用是不是原文连续切片；属性是不是八类枚举；省略的字段是不是一次授权 |
| 已有修复预算 | 失败后的一次重试 | 把协议错误交回模型，由模型重交语义 |
| `needs_review` | 预算用尽后的落点 | 停住，不把输出改写成已经通过 |

现有控制面在 `backend/src/services/storyboard_fact_workflow.ts` 的 `request()`：`连续状态待核对` 已作为 `terminalReview` 进入 `needs_review`。`backend/src/services/fact_state.ts` 的 `reviewExtractedStates` 是正确形状：重问一次，第二次仍错就抛错，提示语不写替代类别。新的准入沿用这条路径，不为每一种模型错误再加一条改写启发式。

字面姓名仍是合格的确定性授权。原文等于名册里唯一的名字时，`resolveScriptBindings` 可以直接 `authority: 'literal'`、`confirmed: true`。这一步没有让模型编号，也没有让 Harness 猜人。

## 为什么要收成一条准入

`ed1e30bb` 之后的修正里，模型交不出合法协议时，Harness 多次改写输出，使检查变成通过。

| 提交 | 改之前的现象 | 当时的做法 | 现在的协议 |
| --- | --- | --- | --- |
| `59d7417` | 少标点或少「只见」就整段拒绝 | 四字前后缀窗口，以及段首 40 字内的真实动作可被尾句覆盖 | T1 |
| `64a20a9` | 身体和姿势进了手持或位置；英文里还有代词 | 丢掉或改名；代词收成一个英文名；关键词或已知译名让审核提前成功；四字前缀把非原文切成原文 | T2、T4、T5 |
| `7651b67` | 模型从 0 编号，待解析下标是 2、3 | 任一非法下标就把整组按返回顺序改号，并在剧本路径自动确认 | T3 |
| `60739f4` | 姿势、赤足、表情被塞进衣着、手持或位置 | 八类和精确错配拒绝已经做对；`position`/`按倒` 仍会写成「位置：按倒」；持久化属性仍是任意字符串 | T5 |
| `6f04545`、`0bfad72` | 年龄和定妆照要进提示词 | 年龄有了列，但缺省更新会清空；参考图缺省被当成同意 | T6、T7 |
| `6a70dcb` | Krea2 CFG 为 1，负面词压不住脸型 | 人物正向锁是对的；侧面、背面和合成空镜仍带着这把锁 | T7 |
| `64a20a9` 测试范围 | 全量测试慢 | 默认 `npm test` 不再跑会失败的准入断言 | T8 |

`0bfad72` 对 codex 与远端 Gemma 递归的打断已经落在 `backend/src/services/llm.ts`，本文不改那条路径。

## 总规则

模型输出只进、不改。每条协议用同一个结果：

```ts
type Admission<T> =
  | { ok: true; value: T; repaired: false }
  | { ok: true; value: T; repaired: true }  // 仅 T3 的整组编错下标
  | { ok: false; review: string };
```

`repaired: true` 只出现在人物下标整组编错、条数和顺序都对的时候。该行可以留下建议，不能 `confirmed: true`。其余失败进入已有的一次修复预算；预算用尽后进入 `needs_review`。

| 协议 | 模型交什么 | Harness 接受什么 | 失败 |
| --- | --- | --- | --- |
| 原文跨度 | 一段它认为的引文 | 去空白和标点后，与原文某个连续切片相同 | `来源片段遗漏` |
| 连续动作拆分 | 至少两段引文 | 直接拼接等于原文，或只差末尾标点 | `连续动作未能拆成可核对的原文片段` |
| 人物绑定 | 按提及顺序的 `{entity_id, status, visibility}` | 合法下标排列照用；整组外部下标且互不重复时按顺序填回 | 缺项、重复、合法与非法混用：`人物自动解析缺项或重复` |
| 连续状态 | 八类之一，取值是本事实子串 | `stateCategoryConflict` 为空 | 重问一次，然后 `连续状态待核对` |
| 译文 | 专名来自词表的英文 | 审核 `faithful === true`，且没有残留代词问题 | `译文待核对` |
| 年龄、参考图 | 客户端显式提交的值 | 键存在才写入；适配器仅在 `use_ref_portrait === true` 时打开 | 缺省保持原值，不挂参考图 |

## T1 原文跨度只接受连续切片

文件：`backend/src/services/storyboard_fact_workflow.ts` 的 `locateSpanInSource`、`anchorSpans`。

`locateSpanInSource` 保留三步：

1. `source.indexOf(spanText, cursor)` 精确命中，存模型原文。
2. `trim` 后精确命中，存原文切片。
3. 去掉空白和标点后，模型文本与原文某个连续切片完全相同，存该切片。

删除第 4 步：四字前缀、四字后缀、1.5 倍窗口。

`anchorSpans` 的段首和段中缺口使用同一条规则：

```ts
const gap = source.slice(cursor, start);
const isGapAllowed = isPunctuationOrFiller(gap);
if (!isGapAllowed) throw new FactWorkflowError(`来源片段遗漏或无法定位: ${blockId}@${cursor}`);
```

删除 `cursor === 0 && start <= 40`。定位失败仍抛 `来源片段遗漏`，由现有修复预算重试一次。

验收：

- `陈月走进房间举起蓝伞看着窗外的雨。` 只引用 `看着窗外的雨。` 时失败。
- 少标点，或多一个「只见」时，存下的是原文切片。

## T2 连续动作拆分不再按四字改写

文件：同文件的 `alignSpansToSource`、`verbatimActionSplit`。

`verbatimActionSplit` 只保留两条成功路径：

- 片段直接拼接等于原文，原样返回。
- 拼接结果是原文的前缀，且剩下的只是标点，把标点补进最后一段后返回。

删除 `alignSpansToSource` 里「清理后拼不上，就用后一段前 4 个字切原文」的分支。拼不上就返回 `null`。调用方继续抛 `连续动作未能拆成可核对的原文片段`。

修复一条已存事实时，拼得上原文但切在分句中间，抛 `分句边界不符`。这次切分不再折成一整段放过。模型交回与原文相同的一段时，仍按这一段收下。

验收：

- `verbatimActionSplit('阿岚打开门并走到屋外。', ['阿岚推开门', '并走到屋外。'])` 为 `null`。
- `verbatimActionSplit('阿岚打开门并走到屋外。', ['阿岚打开门', '并走到屋外。'])` 返回这两段。

这两条断言在 `backend/src/services/ai/storyboard_generation_service.test.ts`，并已进入默认测试。

## T3 人物下标

文件：`backend/src/services/entity_binding.ts` 的 `proposeBindings`、`resolveScriptBindings`。两处共用：

```ts
export function admitBindingRows<T extends { index: number }>(rows: T[], pending: number[])
  : { rows: T[]; repaired: boolean } {
  if (rows.length !== pending.length) throw new Error('人物自动解析缺项或重复');
  const indexes = rows.map(row => row.index);
  if (new Set(indexes).size !== rows.length) throw new Error('人物自动解析缺项或重复');
  const pendingSet = new Set(pending);
  if (indexes.every(index => pendingSet.has(index))) return { rows, repaired: false };
  if (indexes.every(index => !pendingSet.has(index))) {
    return { rows: rows.map((row, i) => ({ ...row, index: pending[i]! })), repaired: true };
  }
  throw new Error('人物自动解析缺项或重复');
}
```

`proposeBindings` 继续全部 `confirmed: false`。分镜事实路径保持「结果仅为待核对建议」。

`resolveScriptBindings`：

- 字面姓名等于名册里唯一的名字时，仍直接确认。
- 模型行只有在 `repaired === false`、`status === 'resolved'`、能在名册里找到人、可见性不是 `uncertain`、且与 `localSubjectForReference` 不矛盾时，才 `confirmed: true`。
- `repaired === true` 时写入建议，`authority: 'model_proposal'`，`confirmed: false`。剧本替换只展开已确认提及，因此这句原文保持不动。

缺项、重复，或合法下标与非法下标混用，函数抛 `人物自动解析缺项或重复`，调用方拿不到可写回的绑定。分镜事实路径把这个错误交给已有的一次修复预算，用尽后进入 `needs_review`。剧本生成路径不把半套结果落成已改写正文。

验收：

- 下标 `3, 2` 这种合法对调，仍按原对应确认。
- 下标 `0, 1` 整组落在待解析集合之外时，建议未确认，原文保持「她把蓝伞递给她」。
- 下标 `0, 0`，或 `3` 与 `9` 混在一起时，抛缺项或重复，原文同样不被改写。

## T4 译文

文件：`backend/src/services/storyboard_fact_workflow.ts` 的译文回写段，以及 `auditFacts`。

删除选定一个英文名之后，把 he、she、him、his、her、they、them、their 替换成该名字的整段。专名缺失、施受关系不对、身体部位归属不对，继续抛已有的 `译文待核对`，走现有的一次重试。

`auditFacts` 删除两类提前成功：

- 中文含软榻、袖袍、拂、转身、应是、点头，或英文含 couch、sleeve、brushed、waved、turned、responded、answered、agreed、nodded，就返回。
- `faithful: false` 时，英文里出现任一已知译名就返回。

`faithful: false` 一律 `译文待核对`。

验收：

- `hands the umbrella to her` 保持原句，并进入待核对。
- `林岚举起蓝伞` 配上 `Lin Lan turned away` 不得通过。

## T5 连续状态

文件：`backend/src/services/fact_state.ts` 的 `stateCategoryConflict`。抽取 schema 已在 `storyboard_fact_workflow.ts` 使用 `z.enum(FACT_STATE_ATTRIBUTES)`，保持该枚举。

在现有精确配对上补两条。提示语不写替代类别：

```ts
if (!isFactStateAttribute(attribute)) return '未知连续状态';
if (attribute === 'position' && (CONTACT.has(value.trim()) || CONTACT.has(item.trim()))) {
  return 'position 与取值不符';
}
```

`CONTACT` 现有成员：按倒、触碰、安抚、拥抱、拉扯、纠缠。`reviewExtractedStates` 保持重问一次，第二次抛 `连续状态待核对`。

抽取清洗不再因为取值不在本事实里就提前丢掉该行。不在原文里的取值仍由证据核对拒绝，并走已有的一次证据重问。重问交回原文子串后，这一行可以留下。

这些组合继续放行，因为现有测试把它们锁成合法：

- `wardrobe` / `脸颊发红`
- `position` / `坐在椅上`
- `position` / `坐忘观`
- `pose` / `坐在椅上`
- `body` / `赤足`

持久化的 `FactStateSchema.attribute` 保持字符串，避免旧候选在读取时整个解析失败。未知属性进不了新的抽取结果。旧记录里的未知属性不参与 `continuityAfter` 的继承。

验收：

- `holding` / `赤足`、`position` / `按倒`、`attribute: 'mood'` 第二次仍错时，镜头停在待核对。
- `pose` / `坐在椅上` 可以继承。表情继续不向后携带。

## T6 年龄

文件：`backend/src/schemas/character.ts`、`backend/src/routes/characters.ts` 的抽取合并、`backend/src/services/character_versions.ts`。

年龄沿用声音字段的缺省写法：

```ts
age: z.union([z.string(), z.number()]).nullable().optional().transform(v => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return String(v);
})
```

PUT 已有 `data.age !== undefined` 才更新列和标签。显式空字符串仍清空。只提交 `{ avatar_url }` 或 `{ turnaround_url }` 时，年龄保持原值。

抽取合并时，`VisualTagsSchema` 默认的 `age: ''` 不铺进已有 `base_model.tags`。没有新年龄时不覆盖旧标签。列继续使用 `COALESCE(?, age)`。

版本插入写入当时的 `character.age`。外观地址没变时，同步活动版本也会写下当前列上的年龄。`activateCharacterVersion` 恢复 `visual_tags` 时，同时把该版本的 `age` 写回 `character.age`。镜头外观读标签；标签没有年龄时用 `character.age`。正式出图若走已固定的角色版本，年龄取该版本行上的 `age`。这与 `characters.ts` 建提示词时「列有年龄而标签没有，则补进外观」的回退一致。

验收：

- 只保存立绘或三视图时，年龄仍在。
- 重新抽取没有年龄时，卡片和镜头提示仍是原来的年龄。
- 切换版本后，列和标签一致。

## T7 参考图与脸部锁

文件：`services/api.ts`、`pages/CharacterManager.tsx`、`backend/src/routes/characters.ts`、`backend/src/services/generation_service.ts`、`backend/src/services/turnaround_composite.ts`。

`use_ref_portrait` 缺省不再当成打开。这三处从 `!== false` 改成 `=== true`：

- `characters.ts` 的 `build-prompt` body 和 `activeRefUrl`
- `generation_service.ts` 里补存档头像的条件
- `turnaround_composite.ts` 里读取存档头像和打开前置适配器的条件

复选框关闭时，请求带 `use_ref_portrait: false`，并且不填 `ref_image_url`、`character_ref_url`、`turnaround_front_adapter`。身份参考只用定妆照。没有定妆照时，不回退到 `turnaround_url`。本次会话尚未保存的定妆照优先于旧头像。

`buildTurnaroundViewPrompt` 对侧面和背面先调用 `stripOrientalFaceLock`，再取外观。正面保留脸部锁。合成出图由 `shotUsesOrientalFaceNegative` 决定是否追加 `ORIENTAL_REALISTIC_NEGATIVE`：定妆、三视图、脸部生成，或镜头契约里有可见人物时追加；空镜不追加。Krea2 工作流的 CFG 为 1，所以背面不能靠负面词里的 face visible 抵消正向锁。

本次会话里刚生成、尚未保存的定妆照会写入参考槽，下一次三视图请求优先用它，而不是旧头像。

验收：

- 取消勾选后，工作流里没有参考图。
- 背面提示不含 East Asian facial features。
- 空镜不追加这组负面词。
- 有可见人物的东方写实正向镜头仍有脸部锁。

## T8 默认测试

文件：`backend/scripts/run-tests.ts` 的 `CORE_TESTS`。

加入：

- `src/services/fact_state.test.ts`
- `src/services/ai/storyboard_generation_service.test.ts`
- `src/services/entity_binding.test.ts`
- `src/routes/character_age_and_turnaround.test.ts`

T1–T7 的断言写在这些已有文件里。默认 `npm test` 会跑到拒绝用例。`npm run test:full` 继续跑全部 `src` 测试。

## 这次不改

- `components/Director/DirectorStoryboardCandidates.tsx` 的错误文案。对白块被写成「动作段落」、对不上的事实 id 被换成「对应剧本段落」，属于展示，不属于这条协议控制面。
- 分镜候选面板的 `panelExpanded` 不随 `script.id` 重置。
- `backend/src/services/llm.ts` 里 codex 与远端 Gemma 的递归。当前非 codex override 已经打断循环。

## 落地记录

T1–T8 已在同一批修改里完成，新断言与协议同一批进入默认测试。核对时跑过这四个文件，以及剧本生成、角色版本和出图服务的相邻测试。角色页勾选框没有在浏览器里点过；参考图开关和背面提示由接口测试覆盖。

## 相关代码

| 入口 | 路径 |
| --- | --- |
| 事实工作流与修复预算 | `backend/src/services/storyboard_fact_workflow.ts` |
| 连续状态准入 | `backend/src/services/fact_state.ts` |
| 事实契约 | `backend/src/schemas/storyboard_facts.ts` |
| 人物绑定 | `backend/src/services/entity_binding.ts` |
| 角色更新与提示词 | `backend/src/schemas/character.ts`、`backend/src/routes/characters.ts` |
| 版本 | `backend/src/services/character_versions.ts` |
| 三视图 | `backend/src/services/turnaround_composite.ts`、`pages/CharacterManager.tsx` |
| 出图参考图补齐 | `backend/src/services/generation_service.ts` |
| 默认测试列表 | `backend/scripts/run-tests.ts` |
