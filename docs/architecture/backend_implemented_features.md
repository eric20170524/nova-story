# Node.js 后端已实现能力

后端入口为 `backend/src/server.ts`，生产构建输出到 `backend/dist`。  
文档索引见 [README.md](../README.md)。

## 领域能力

- 项目、章节、角色、场景、工作流完整 CRUD
- TXT 项目导入、完整 JSON 导出和项目复制
- 章节自动分镜与场景编辑
- 单场景 9 镜头 coverage 的生成、应用与提升
- AI 续写、内容分析、上下文读取和导演助手工具调用
- **Agent OS（写作内核）**：多 Action 决策 + Zod 自愈；`POST /assistant/execute` 确认后执行；分层记忆与负向约束续写；一致性体检 / 定稿影响 / 写作技能；项目术语表 `glossary`；见 [agent_os_plan_cn.md](./agent_os_plan_cn.md)
- **本章定稿同步**：`APPLY_CHAPTER_IMPACT` 与 `POST /agent/impact` 共用完整正文提取，角色（含性格/外观）、术语、`settings.main_plot`（角色状态 / 事件 / 伏笔）、`settings.character_relations` 一并提交；`apply:false` 只预览。自动记录按章节排序，同章重新定稿替换原记录，保留已有作者设定。执行报告展示两项设定的更新结果。
- 角色抽取、跨章节外观演化、素材上传与头像裁剪
- **场景 / 角色内容版本**：基线版本、新建版本、激活版本、资产同步（A/B 试图）
- 图片任务：`generation_task` SQLite 持久化、状态查询、SSE、Redis 可选 Pub/Sub  
- 取消：按任务关联的 ComfyUI `prompt_id` 删队列 + interrupt；重启后 orphan processing → interrupted
- **角色三视图**：分视生成（front/side/back）+ 横向拼接（`turnaround_composite.ts`）

### 本章定稿验收矩阵

2026-09-30 验证：模型返回使用测试桩，API / Agent 执行链路与 SQLite 写入、回滚使用真实实现；报告使用浏览器核验示例排版。

| 场景 | 验收结果 |
| --- | --- |
| 定稿应用 | 角色性格、外观、术语、主线时间线与人物关系全部写入 |
| 只读预览 | 返回时间线与关系预览，不改角色、术语或项目设定；报告明确未写入 |
| 重新定稿 / 多章 | 同章自动记录替换，按章节顺序排列，保留作者设定和其他配置 |
| 长章末尾 | 原 5000 字截断后的事件、伏笔也参与提取与合并 |
| 生成失败 / 数据库拒绝写入 | 返回失败，角色、术语、设定没有部分提交 |
| 生成期间修改 | 正文变化拒绝应用；设定变化重新读取后合并 |
| 仅设定有变化 | 无角色或术语增量时，报告仍显示时间线与关系更新 |

回归用例：`backend/src/services/ai/chapter_impact.test.ts`、`components/agent/AgentExecutionResultCard.test.tsx`。

## AI 与媒体

- 文本：Gemini、OpenAI、Grok、Ollama 和 OpenAI 兼容服务
- 结构化输出：Zod JSON Schema、校验、重试和模式化降级
- 云生图：Gemini/Imagen、OpenAI Images、xAI 兼容端点
- 本地生图：ComfyUI 自动探活/启动、内置 **Pony XL** + **SD1.5 Draft** 工作流、参考图、参数注入、LoRA 实际连线
- **模型族贯通**：`model_type` / `reference_model_type` 支持 `pony` | `sd15`（legacy `flux` 在客户端与角色 prompt 路径回落为 pony）；`normalizeImageModelFamily` 统一解析
- **FLUX.1-dev GGUF 已退役**（3060 12GB 不推荐）：权重/下载脚本/内置工作流已清理，见 [local_image_generation_deployment_cn.md](../deployment/local_image_generation_deployment_cn.md)
- **档位 A/B 参考策略**（详见 [local_image_reference_policy_cn.md](../deployment/local_image_reference_policy_cn.md)）：
  - A：标签 + 角色 LoRA + 文本构图；单图 img2img 仅限立绘/三视图/特写
  - B（Pony/SDXL）：`character_ref` → IP-Adapter；`composition_ref` → ControlNet；缺节点/模型静默回退 A
  - **门禁**：双人 / 远景 / 动作镜**禁止**单图 IP-Adapter 锁构图（与 img2img 叙事门禁对齐）；`reference_tier: "A"` / `force_no_character_adapter` 可强制关闭
  - 探测：`GET /api/settings/tier-b-status`；安装脚本 `scripts/setup_tier_b_comfyui.ps1`
  - SD1.5 草稿默认档位 A，且不自动挂 Pony/SDXL LoRA
- Pony/SDXL：东亚特征提示增强及本地风格 LoRA 自动发现；动作/战后镜剥离 alluring 类风格叙事词
- **NSFW 开关驱动的默认生图策略**（`image_generation_policy.ts`）：
  - **开启 NSFW**：自动叠加载 风格/细节 LoRA + 成人向 LoRA（Pony：Detail + Incase 类），去重、缺文件按文件名模式自动发现；提示词注入 unlock/rating 与触发词；分镜 LLM 按成人向英文标签策略生成
  - **关闭 NSFW**：仅风格/细节 LoRA（绝不自动挂 Incase 等成人 LoRA）；强制 SFW 负向词；分镜 LLM 要求全年龄向描述
  - 风格预设（`style_preset`）自动追加国风/仙侠等 booster

## 数据与可靠性

- SQLite 幂等版本迁移（含 scene / character versions）
- 完整领域表和索引
- 内置工作流自动初始化；退役 bundled 工作流（如 `flux_dev_*`）启动时从库中清理
- 时间线替换、coverage 提升、项目/章节删除使用事务
- 旧数据库缺失级联约束时执行显式子记录清理
- 配置目录、数据目录和静态目录可通过 `NOVASTORY_*_DIR` 独立挂载（默认静态根：`backend/static/`，HTTP 前缀仍为 `/static/`）
- **安全默认**：监听 `127.0.0.1`；CORS 限 localhost；`GET /settings` 脱敏（`has_api_key`，不回传密钥）

## 验证

| 范围 | 命令 |
| --- | --- |
| 前端类型检查 + 构建 | 仓库根 `npm run check` |
| 后端类型检查 | `cd backend && npm run typecheck` |
| 后端单测 | `cd backend && npm test` |
| 后端生产编译 | `cd backend && npm run build` |

完整 Fastify 应用测试会对照契约检查 OpenAPI 路由。

## 相关对照实验

- `local/shortstory/xianxia_duel/`：Pony 多版本分镜对照（含 v4 IP 失败 / v4.1 无 IP 修复）
- 批跑脚本：`backend/scripts/gen_duel_pony_v4.ts`
