import Fastify from 'fastify';
import FastifyMiddie from '@fastify/middie';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import dotenv from 'dotenv';
import { buildApp } from './backend/src/server';
import { getConfigDirectory } from './backend/src/core/paths';

const envPath = path.join(getConfigDirectory(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}

async function startServer() {
  // Loopback by default — do not bind 0.0.0.0 unless HOST is set explicitly.
  const PORT = Number(process.env.PORT || process.env.NOVASTORY_PORT || 3000);
  const HOST = process.env.HOST || process.env.NOVASTORY_HOST || '127.0.0.1';

  const app = await buildApp({ logger: true });
  app.server.requestTimeout = 30 * 60 * 1000;
  app.server.headersTimeout = 31 * 60 * 1000;
  app.server.keepAliveTimeout = 30 * 60 * 1000;
  app.server.timeout = 30 * 60 * 1000;

  if (process.env.NODE_ENV !== 'production') {
    await app.register(FastifyMiddie);

    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
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
    if (HOST === '0.0.0.0') {
      const interfaces = os.networkInterfaces();
      for (const [name, addrs] of Object.entries(interfaces)) {
        for (const addr of addrs || []) {
          if (addr.family === 'IPv4' && !addr.internal) {
            console.log(`  ➜  LAN URL:  http://${addr.address}:${PORT}/ (interface: ${name})`);
          }
        }
      }
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

startServer();
