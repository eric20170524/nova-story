import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Product spine for `npm test`. `npm run test:full` still runs every src test. */
const CORE_TESTS = [
  'src/db/database.test.ts',
  'src/server.test.ts',
  'src/schemas/story_plan.test.ts',
  'src/schemas/script_boundary.test.ts',
  'src/schemas/llm.timeline.test.ts',
  'src/schemas/video.test.ts',
  'src/routes/scripts.test.ts',
  'src/routes/timeline.contract.test.ts',
  'src/routes/coverage.compile.test.ts',
  'src/services/story_plan_service.test.ts',
  'src/services/script_service.test.ts',
  'src/services/script_review_regressions.test.ts',
  'src/services/ai/script_generation_service.test.ts',
  'src/services/ai/writing_protection_skills.test.ts',
  'src/services/pony_prompt_compiler.test.ts',
  'src/services/visual_prompt_sanitizer.test.ts',
  'src/services/visual_prompt_uniqueness.test.ts',
  'src/services/negative_prompt_compiler.test.ts',
  'src/services/image_generation_policy.test.ts',
  'src/services/image_output_spec.test.ts',
  'src/services/shot_intent_quota.test.ts',
  'src/services/scene_visual_prompt_service.test.ts',
  'src/services/english_visual_prompt.test.ts',
  'src/services/comfy_workflow_selection.test.ts',
  'src/services/reference_generation_policy.test.ts',
  'src/services/generation_service.test.ts',
  'src/services/project_settings.test.ts',
  'src/services/formal_storyboard_capability.test.ts',
  'src/services/formal_storyboard_plan.test.ts',
  'src/services/fact_state.test.ts',
  'src/services/ai/storyboard_generation_service.test.ts',
  'src/services/entity_binding.test.ts',
  'src/routes/character_age_and_turnaround.test.ts',
  'src/services/asset_library_service.test.ts',
  'src/services/scene_production.test.ts',
  'src/services/video/video_spec_compiler.test.ts',
  'src/services/video/video_workflow_compiler.test.ts',
  'src/services/video/video_storyboard_keyframe.test.ts',
];

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
  const runAll = process.argv.includes('--all');
  const passthrough = process.argv.slice(2).filter((arg) => arg !== '--all' && arg !== '--core');
  const hasConcurrency = passthrough.some(
    (arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency=')
  );
  // Explicit files select a targeted run; do not append the suite again.
  const hasSelectedFiles = passthrough.some(arg => !arg.startsWith('-') && arg.endsWith('.test.ts'));
  let tests: string[] = [];
  if (!hasSelectedFiles && runAll) {
    tests = (await collectTests(path.resolve('src'))).sort();
    if (tests.length === 0) throw new Error('No backend test files were found');
  } else if (!hasSelectedFiles) {
    tests = CORE_TESTS.map((file) => path.resolve(file));
    for (const file of tests) {
      try {
        await access(file);
      } catch {
        throw new Error(`Core test file is missing: ${file}`);
      }
    }
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
