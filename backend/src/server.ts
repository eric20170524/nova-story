import Fastify from 'fastify';
import cors from '@fastify/cors';
import { db } from './db/database';

const app = Fastify({
  logger: true
});

app.register(cors, {
  origin: '*'
});

app.get('/', async (request, reply) => {
  return { message: 'NovaStory Fastify+SQLite Backend Operational' };
});

app.get('/api/test-db', async (request, reply) => {
  const result = await db.get('SELECT sqlite_version() as version');
  return { db_version: result.version };
});

const start = async () => {
  try {
    await app.listen({ port: 8087, host: '0.0.0.0' });
    app.log.info(`Server listening on ${app.server.address()}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
