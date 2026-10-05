import fs from 'node:fs';
import path from 'node:path';
import { localQueueDir } from './local-queue.mjs';

const queue = localQueueDir('NOVASTORY_GROK_VIDEO_QUEUE_DIR', 'grok-video-jobs');
const [action = 'list', id, input, sourceUrl] = process.argv.slice(2);
const validId = value => /^vtask_[0-9a-f]{16}$/.test(String(value || ''));
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
    return { ...job, status: fs.existsSync(jobFile(job.task_id, 'result.json')) ? 'resolved' : 'pending' };
  }).filter(job => job.status === 'pending');
  console.log(JSON.stringify(jobs, null, 2));
} else if (action === 'complete') {
  if (!validId(id) || !input) throw new Error('Usage: grok-video-jobs.mjs complete TASK_ID /absolute/video.mp4 [source_url]');
  if (!fs.existsSync(jobFile(id, 'request.json'))) throw new Error('Unknown Grok video task');
  const data = fs.readFileSync(path.resolve(input));
  if (data.length < 1024 || data.subarray(4, 8).toString() !== 'ftyp') throw new Error('Expected a nonempty MP4 video');
  fs.writeFileSync(jobFile(id, 'mp4'), data, { flag: 'wx' });
  writeAtomic(jobFile(id, 'result.json'), { task_id: id, status: 'completed', source_url: sourceUrl || null, completed_at: new Date().toISOString() });
  console.log(JSON.stringify({ task_id: id, status: 'completed', bytes: data.length }));
} else if (action === 'fail') {
  if (!validId(id) || !input) throw new Error('Usage: grok-video-jobs.mjs fail TASK_ID reason');
  if (!fs.existsSync(jobFile(id, 'request.json'))) throw new Error('Unknown Grok video task');
  writeAtomic(jobFile(id, 'result.json'), { task_id: id, status: 'failed', error: input, completed_at: new Date().toISOString() });
  console.log(JSON.stringify({ task_id: id, status: 'failed' }));
} else {
  throw new Error('Usage: grok-video-jobs.mjs list | complete TASK_ID FILE [source_url] | fail TASK_ID reason');
}
