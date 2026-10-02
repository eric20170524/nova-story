import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { getDataDirectory } from '../../core/paths';
import type { AIProvider, ImageGenerationOptions, StructuredGenOptions } from './base';

const TEXT_TIMEOUT_MS = 15 * 60 * 1000;
const IMAGE_TIMEOUT_MS = 40 * 60 * 1000;
const IMAGE_POLL_MS = 1500;

function codexExecutable(): string {
  return process.env.NOVASTORY_CODEX_CLI || 'codex';
}

function childEnvironment(): NodeJS.ProcessEnv {
  // The model needs the user's Codex sign-in, never the server's unrelated API secrets.
  return Object.fromEntries(
    ['HOME', 'PATH', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']
      .filter(key => process.env[key] != null)
      .map(key => [key, process.env[key]])
  );
}

async function runCodex(prompt: string, schema?: unknown): Promise<string> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-codex-'));
  const output = path.join(scratch, 'response.txt');
  const schemaFile = path.join(scratch, 'schema.json');
  if (schema) fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const args = [
    'exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
    '-C', scratch, '-m', process.env.NOVASTORY_CODEX_MODEL || 'gpt-6.1-sol',
    '-c', `model_reasoning_effort=${process.env.NOVASTORY_CODEX_EFFORT || 'low'}`,
    '-o', output,
    ...(schema ? ['--output-schema', schemaFile] : []),
    '-',
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(codexExecutable(), args, { env: childEnvironment(), stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Codex text generation timed out')); }, TEXT_TIMEOUT_MS);
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Codex CLI exited ${code}: ${stderr.slice(-1200)}`));
      });
      child.stdin.end(prompt);
    });
    const response = fs.readFileSync(output, 'utf8').trim();
    if (!response) throw new Error('Codex returned an empty response');
    return response;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Uses the signed-in Codex CLI for text. Image requests are queued for the
 * current Codex session's built-in image tool, while callers keep their normal
 * NovaStory generation task and persistence flow. */
export class CodexProvider implements AIProvider {
  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    return runCodex([
      '你是 NovaStory 的创作引擎。只返回请求的正文，不解释流程，不调用工具。',
      systemInstruction ? `系统要求：\n${systemInstruction}` : '',
      `创作请求：\n${prompt}`,
    ].filter(Boolean).join('\n\n'));
  }

  async generateStructured<T>(
    prompt: string,
    responseSchema: z.ZodSchema<T>,
    systemInstruction?: string,
    options?: StructuredGenOptions
  ): Promise<T> {
    const schema = z.toJSONSchema(responseSchema) as Record<string, unknown>;
    // The CLI's strict schema subset rejects legitimate Zod constructs used by
    // the existing routes (optional fields, propertyNames and z.any). Give the
    // model the schema as guidance, then let each route's Zod parser decide.
    const response = await runCodex([
      '你是 NovaStory 的结构化创作引擎。只输出 JSON；不要 Markdown 或解释，不调用工具。',
      options?.systemInstruction || systemInstruction || '',
      `请求：\n${prompt}`,
      Object.keys(schema).length ? `输出须符合以下 JSON Schema。required 中列出的字段必须存在，其余字段可省略：\n${JSON.stringify(schema)}` : '',
    ].filter(Boolean).join('\n\n'));
    const unfenced = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(unfenced);
    } catch {
      const first = Math.min(...['{', '['].map(token => {
        const position = unfenced.indexOf(token);
        return position < 0 ? Number.POSITIVE_INFINITY : position;
      }));
      const last = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'));
      if (!Number.isFinite(first) || last <= first) throw new Error('Codex did not return JSON');
      parsed = JSON.parse(unfenced.slice(first, last + 1));
    }
    return responseSchema.parse(parsed);
  }

  async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<{ data?: Buffer; error?: string }> {
    const queue = path.resolve(process.env.NOVASTORY_CODEX_IMAGE_QUEUE_DIR || path.join(getDataDirectory(), 'codex-image-jobs'));
    fs.mkdirSync(queue, { recursive: true });
    const { resumeJobId, ...requestOptions } = options || {};
    if (resumeJobId && !/^[0-9a-f-]{36}$/i.test(resumeJobId)) return { error: 'Invalid Codex image resume job ID' };
    const id = resumeJobId || randomUUID();
    const requestPath = path.join(queue, `${id}.request.json`);
    const responsePath = path.join(queue, `${id}.result.json`);
    const imagePath = path.join(queue, `${id}.png`);
    if (resumeJobId) {
      if (!fs.existsSync(requestPath)) return { error: 'Timed-out Codex image request is missing' };
      const prior = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
      if (prior.prompt !== prompt || JSON.stringify(prior.options || {}) !== JSON.stringify(requestOptions)) {
        return { error: 'Timed-out Codex image request does not match the asset being retried' };
      }
    } else {
      fs.writeFileSync(requestPath, JSON.stringify({ id, kind: 'image', prompt, options: requestOptions, created_at: new Date().toISOString() }, null, 2), { flag: 'wx' });
    }
    const deadline = Date.now() + IMAGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responsePath)) {
        const result = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
        if (result.error) return { error: String(result.error) };
        if (!fs.existsSync(imagePath)) return { error: 'Codex image result has no PNG file' };
        const data = fs.readFileSync(imagePath);
        if (data.length < 1024 || data.length > 30 * 1024 * 1024 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
          return { error: 'Codex image result is not a valid PNG' };
        }
        return { data };
      }
      await new Promise(resolve => setTimeout(resolve, IMAGE_POLL_MS));
    }
    return { error: `Codex image job ${id} timed out; request preserved at ${requestPath}` };
  }
}
