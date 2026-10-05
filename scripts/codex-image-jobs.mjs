import fs from 'node:fs';
import path from 'node:path';
import { localQueueDir } from './local-queue.mjs';

const queue = localQueueDir('NOVASTORY_CODEX_IMAGE_QUEUE_DIR', 'codex-image-jobs');
const [action = 'list', id, input] = process.argv.slice(2);
const validId = value => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(value || ''));
const jobFile = (jobId, suffix) => path.join(queue, `${jobId}.${suffix}`);
const writeAtomic = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
};

if (action === 'list') {
  fs.mkdirSync(queue, { recursive: true });
  const jobs = fs.readdirSync(queue).filter(file => file.endsWith('.request.json')).map(file => {
    const job = JSON.parse(fs.readFileSync(path.join(queue, file), 'utf8'));
    return { ...job, status: fs.existsSync(jobFile(job.id, 'result.json')) ? 'resolved' : 'pending' };
  }).filter(job => job.status === 'pending');
  console.log(JSON.stringify(jobs, null, 2));
} else if (action === 'complete') {
  if (!validId(id) || !input) throw new Error('Usage: codex-image-jobs.mjs complete JOB_ID /absolute/generated.png');
  const requestPath = jobFile(id, 'request.json');
  if (!fs.existsSync(requestPath)) throw new Error('Unknown image job');
  const source = path.resolve(input);
  const data = fs.readFileSync(source);
  if (data.length < 1024 || data.length > 30 * 1024 * 1024 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Expected a PNG between 1 KiB and 30 MiB');
  }
  fs.writeFileSync(jobFile(id, 'png'), data, { flag: 'wx' });
  writeAtomic(jobFile(id, 'result.json'), { id, status: 'completed', completed_at: new Date().toISOString() });
  console.log(JSON.stringify({ id, status: 'completed', bytes: data.length }));
} else if (action === 'fail') {
  if (!validId(id) || !input) throw new Error('Usage: codex-image-jobs.mjs fail JOB_ID reason');
  if (!fs.existsSync(jobFile(id, 'request.json'))) throw new Error('Unknown image job');
  writeAtomic(jobFile(id, 'result.json'), { id, status: 'failed', error: input, completed_at: new Date().toISOString() });
  console.log(JSON.stringify({ id, status: 'failed' }));
} else {
  throw new Error('Usage: codex-image-jobs.mjs list | complete JOB_ID FILE | fail JOB_ID reason');
}
