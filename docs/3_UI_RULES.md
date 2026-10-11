# 3_UI_RULES.md: UI 与设计规范

本 Sprint 以后端 Prompt 管道为主。未改 UI 的任务不要为了「补规范」去回填全站。

## 1. 核心准则

- Director / Story / Characters 是工作台，不是营销站。信息密度优先于装饰。
- 交互元素新增或本任务改到的控件：加 `data-testid`，测试禁止依赖 i18n 文本或深 CSS 层级。
- 现仓库大量历史控件没有 `data-testid`。不在本 Sprint 做全站回填，除非任务明确要求。
- 列表、工作流、模型、风格必须跟后端数据走，禁止在前端写死渠道名 / 模型文件名（除文档示例）。

## 2. 国际化（强制）

可见文案不得在组件里写死中英文字符串。

- 钩子：`useLanguage()`（`LanguageContext.tsx`）
- 调用：`t('key.path')`
- 词典：根目录 `locales.ts` 的 `en` 与 `zh` **同步**新增
- 默认语言：中文
- Toast / Modal / 空状态 / 按钮全部走词典

例外：分镜 `visual_prompt` 本身是给 Pony 的英文 tag，展示原文，不当作 UI chrome 翻译。

## 3. 视觉与组件

- 样式：Tailwind 工具类。不要为本 Sprint 新建全局 CSS 体系。
- 图标：`lucide-react`。
- 异步：沿用现有 Skeleton / 按钮 loading；错误用 `useToast()`（`ToastContext.tsx`），不要 `alert`。
- 危险操作（删除 Timeline、覆盖正式分镜、删除项目）：必须二次确认。
- **Prompt 重编译若会改正式 Scene：** 走 scene version 或明确确认，禁止静默覆盖已有 `asset_url`。

## 4. 本 Sprint 若改 Director

允许的 UI 工作（仅当任务需要）：

- 展示 / 编辑 `visual_prompt`、`negative_prompt`、`shot_type`
- 触发已有 `POST /api/timeline/prompts/regenerate`（语义将改为「按契约重编译」）
- 版本切换

不要借机重做时间轴布局、九宫格、或新增第二种分镜模式。

## 5. Track 8 明确授权的制作入口（2026-10-11）

用户要求保留构图草稿，并新增“生成正式分镜图”。实施范围以 [Track 8](./0_TASKLIST.md#track8-production-storyboards) 的修订契约为准。第 4 节不阻止这两个入口；它们属于同一镜头/时间线，不新建平行剧本，也不重做时间轴布局。

- 镜头卡只保留两个生成动作。「生成本版」改为「生成构图草稿」：已有图片时写入未激活草稿版本，不覆盖活动图。「+新版生成」并入这个草稿动作，不再单独存在。
- 「生成 16:9 关键帧 / 重新生成」删除，不再作为第三条无阶段入口。关键帧页只展示草稿预览、正式候选和已采纳图，并标明阶段。
- 「生成正式分镜图」与文字向的「生成分镜候选 / 采纳此候选」分开。新 `data-testid` 使用 `director-generate-draft`、`director-generate-production`、`director-production-adopt`、`director-production-reject`，不复用 `storyboard-adopt-*`。
- 正式按钮先显示参考和缺项。能力未开放时可见，但提交失败并说明原因。候选完成后仍待验收；六项核对通过并采纳后，才成为活动正式图。
- 方形分镜区域只展示草稿。正式候选和已采纳图按 16:9 全幅查看，不以方形裁切作为验收画面。
- 失败、取消和刷新保留已选图。新增文案走中英字典；新增控件遵守已有异步交互。
