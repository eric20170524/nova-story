import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

const tests = (await collectTests(path.resolve('src'))).sort();
if (tests.length === 0) {
  throw new Error('No backend test files were found');
}

for (const testFile of tests) {
  await import(pathToFileURL(testFile).href);
}
