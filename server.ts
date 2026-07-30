import Fastify from 'fastify';
import FastifyMiddie from '@fastify/middie';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { buildApp } from './backend/src/server';

async function startServer() {
  const PORT = 3000;
  const HOST = '0.0.0.0';

  const app = await buildApp({ logger: true });

  await app.register(FastifyMiddie);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });

    app.use((req: any, res: any, next: any) => {
      if (
        req.url &&
        (req.url.startsWith('/api') ||
         req.url.startsWith('/static') ||
         req.url.startsWith('/docs') ||
         req.url === '/openapi.json')
      ) {
        return next();
      }
      vite.middlewares(req, res, next);
    });
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api') || req.url.startsWith('/static')) {
          reply.status(404).send({ error: 'Not found' });
        } else {
          reply.sendFile('index.html', distPath);
        }
      });
    }
  }

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`NovaStory Full-Stack Fastify Server running on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

startServer();
