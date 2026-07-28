# NovaStory 前端

前端位于仓库根目录，采用 React、Vite 和 TypeScript。

## 开发

```bash
npm install
npm run dev
```

开发地址为 `http://localhost:3000/novastory/`，API 指向 `http://127.0.0.1:8087/api`。

## 验证与构建

```bash
npm run check
```

该命令先执行 TypeScript 检查，再生成生产构建到 `dist/`。

生产构建通过同域 `/novastory/api` 调用后端。仓库根目录的 Dockerfile 和 Nginx 配置已经处理前端路由、API 反向代理以及 `/static/` 素材代理。
