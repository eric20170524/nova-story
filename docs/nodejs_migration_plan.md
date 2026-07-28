# Node.js 完整迁移与 main 基准对齐

## 基准

- 功能基准：`origin/main@8cb3a6d`
- 迁移起点：`origin/nodejs@19e2722`
- 长期主实现：`nodejs`
- 基准契约：main 暴露的 48 个 HTTP 方法/路径

main 只用于追溯行为，不继续维护 Python/Node 双实现。

## 已完成阶段

### 1. 工程与数据

- 修复前后端 TypeScript 配置
- 建立 SQLite 版本迁移与索引
- 补齐 Character、Scene、Coverage、Workflow 表
- 初始化 Pony XL 与 FLUX 内置工作流
- 兼容历史数据库缺失列和缺失级联约束

### 2. API 基准

- 补齐 Creative Agent 4 个接口
- 补齐 Assistant Chat 1 个接口
- 补齐 Coverage 4 个接口
- 通过 OpenAPI 契约锁定 main 的 48 个操作
- 统一 Zod 校验错误为 HTTP 422
- 恢复 Swagger UI 与 OpenAPI JSON

### 3. AI 与媒体

- 对齐续写、分析、分镜、coverage、角色演化提示与降级
- 修复导演助手章节分析占位实现
- 实现 Gemini/Imagen 真实图像字节解析
- 分离文本 LLM 与图片提供方选择
- 补齐 ComfyUI 探活/启动、工作流选择、参考图、采样参数和 LoRA 连线
- 对齐 FLUX 东亚提示增强和本地风格 LoRA 发现

### 4. 共享业务

- 对齐角色抽取和跨章节外观变体
- 导入时保留角色声明
- 漫画字幕真正写入图片并输出 PDF
- 项目/章节删除使用显式事务级联

### 5. 质量与交付

- 后端类型检查、生产编译与自动化测试
- 前端类型检查与生产构建
- 可运行的 Node 后端/前端 Dockerfile、Nginx 和 Compose
- Windows 一键启动继续使用 Fastify 8087
- API、架构和部署文档切换到 Node 实现

## 验收门槛

自动化门槛：

- `backend/npm run check`
- `backend/npm run build`
- 根目录 `npm run check`
- OpenAPI 中 main 的 48 个操作全部存在
- 新建内存数据库能够完成迁移、关键路由、coverage 生命周期和级联删除

环境相关门槛：

- 使用实际密钥分别验证选定 LLM 和云生图提供方
- 在目标 GPU 机器验证 Pony/FLUX 工作流和已安装 LoRA
- 在目标系统验证中文字体渲染
- 部署环境执行 `docker compose up --build` 冒烟测试

环境相关门槛不适合写死到 CI；应在发布清单中记录提供方、模型、工作流和机器配置。
