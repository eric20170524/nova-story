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
