import Fastify from 'fastify';
import FastifyMiddie from '@fastify/middie';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { buildApp } from './backend/src/server';

async function startServer() {
  // Loopback by default — do not bind 0.0.0.0 unless HOST is set explicitly.
  const PORT = Number(process.env.PORT || process.env.NOVASTORY_PORT || 3000);
  const HOST = process.env.HOST || process.env.NOVASTORY_HOST || '127.0.0.1';

  const app = await buildApp({ logger: true });

  if (process.env.NODE_ENV !== 'production') {
    await app.register(FastifyMiddie);

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
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      vite.middlewares(req, res, next);
    });
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
