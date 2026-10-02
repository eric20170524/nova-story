import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const collectTests = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTests(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }

  return files;
};

const main = async () => {
  const passthrough = process.argv.slice(2);
  const hasConcurrency = passthrough.some(
    (arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency=')
  );
  const tests = (await collectTests(path.resolve('src'))).sort();
  if (tests.length === 0) {
    throw new Error('No backend test files were found');
  }

  // Default to serial execution — concurrent entry was flaky (170/171).
  const args = [
    '--import', 'tsx',
    '--test',
    '--test-force-exit',
    ...(hasConcurrency ? [] : ['--test-concurrency=1']),
    ...passthrough,
    ...tests,
  ];
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: ':memory:' },
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });

  process.exitCode = exitCode;
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
