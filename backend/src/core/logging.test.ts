import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getLogRetentionDays, cleanOldLogFiles, logger } from './logging';

test('getLogRetentionDays returns 3 by default when no environment variable is set', () => {
  const savedEnv1 = process.env.LOG_RETENTION_DAYS;
  const savedEnv2 = process.env.NOVASTORY_LOG_RETENTION_DAYS;
  const savedEnv3 = process.env.LOG_MAX_DAYS;

  try {
    delete process.env.LOG_RETENTION_DAYS;
    delete process.env.NOVASTORY_LOG_RETENTION_DAYS;
    delete process.env.LOG_MAX_DAYS;

    assert.equal(getLogRetentionDays(), 3);
  } finally {
    if (savedEnv1 !== undefined) process.env.LOG_RETENTION_DAYS = savedEnv1;
    if (savedEnv2 !== undefined) process.env.NOVASTORY_LOG_RETENTION_DAYS = savedEnv2;
    if (savedEnv3 !== undefined) process.env.LOG_MAX_DAYS = savedEnv3;
  }
});

test('getLogRetentionDays reads configurable retention days from environment variables', () => {
  const savedEnv1 = process.env.LOG_RETENTION_DAYS;
  const savedEnv2 = process.env.NOVASTORY_LOG_RETENTION_DAYS;
  const savedEnv3 = process.env.LOG_MAX_DAYS;

  try {
    delete process.env.NOVASTORY_LOG_RETENTION_DAYS;
    delete process.env.LOG_MAX_DAYS;

    process.env.LOG_RETENTION_DAYS = '7';
    assert.equal(getLogRetentionDays(), 7);

    delete process.env.LOG_RETENTION_DAYS;
    process.env.NOVASTORY_LOG_RETENTION_DAYS = '5';
    assert.equal(getLogRetentionDays(), 5);

    delete process.env.NOVASTORY_LOG_RETENTION_DAYS;
    process.env.LOG_MAX_DAYS = '10';
    assert.equal(getLogRetentionDays(), 10);
  } finally {
    if (savedEnv1 !== undefined) process.env.LOG_RETENTION_DAYS = savedEnv1;
    else delete process.env.LOG_RETENTION_DAYS;
    if (savedEnv2 !== undefined) process.env.NOVASTORY_LOG_RETENTION_DAYS = savedEnv2;
    else delete process.env.NOVASTORY_LOG_RETENTION_DAYS;
    if (savedEnv3 !== undefined) process.env.LOG_MAX_DAYS = savedEnv3;
    else delete process.env.LOG_MAX_DAYS;
  }
});

test('getLogRetentionDays falls back to 3 on invalid env values', () => {
  const savedEnv = process.env.LOG_RETENTION_DAYS;

  try {
    process.env.LOG_RETENTION_DAYS = 'invalid_number';
    assert.equal(getLogRetentionDays(), 3);

    process.env.LOG_RETENTION_DAYS = '0';
    assert.equal(getLogRetentionDays(), 3);

    process.env.LOG_RETENTION_DAYS = '-5';
    assert.equal(getLogRetentionDays(), 3);
  } finally {
    if (savedEnv !== undefined) process.env.LOG_RETENTION_DAYS = savedEnv;
    else delete process.env.LOG_RETENTION_DAYS;
  }
});

test('cleanOldLogFiles removes files older than retention days and keeps recent 3 days', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-log-test-'));

  try {
    // Reference date: 2026-09-30 12:00:00
    const now = new Date(2026, 8, 30, 12, 0, 0); // Month 8 is September (0-indexed)

    // Create log files for:
    // Today (2026-09-30) -> Keep
    // Yesterday (2026-09-29) -> Keep
    // 2 days ago (2026-09-28) -> Keep
    // 3 days ago (2026-09-27) -> Delete (since retention = 3 keeps 09-30, 09-29, 09-28)
    // 5 days ago (2026-09-25) -> Delete
    const filesToCreate = [
      'novastory.2026-09-30.1.log',
      'novastory.2026-09-29.1.log',
      'novastory.2026-09-28.1.log',
      'novastory.2026-09-27.1.log',
      'novastory.2026-09-25.1.log',
      'other.txt', // Non-log file, must not be deleted
    ];

    for (const file of filesToCreate) {
      fs.writeFileSync(path.join(tempDir, file), `log content for ${file}`);
    }

    // Also create a subdirectory to ensure directories are not deleted or causing errors
    fs.mkdirSync(path.join(tempDir, 'subfolder'));

    const deleted = cleanOldLogFiles(tempDir, 3, now);

    assert.equal(deleted.length, 2);
    assert.ok(deleted.includes('novastory.2026-09-27.1.log'));
    assert.ok(deleted.includes('novastory.2026-09-25.1.log'));

    const remainingFiles = fs.readdirSync(tempDir);
    assert.ok(remainingFiles.includes('novastory.2026-09-30.1.log'));
    assert.ok(remainingFiles.includes('novastory.2026-09-29.1.log'));
    assert.ok(remainingFiles.includes('novastory.2026-09-28.1.log'));
    assert.ok(remainingFiles.includes('other.txt'));
    assert.ok(remainingFiles.includes('subfolder'));
    assert.ok(!remainingFiles.includes('novastory.2026-09-27.1.log'));
    assert.ok(!remainingFiles.includes('novastory.2026-09-25.1.log'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cleanOldLogFiles ages the active novastory.log by mtime and leaves other services alone', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-log-mtime-test-'));

  try {
    const now = new Date(2026, 8, 30, 12, 0, 0);

    const oldLog = path.join(tempDir, 'novastory.log');
    const recentLog = path.join(tempDir, 'novastory.log');
    const foreignDated = path.join(tempDir, 'other-service.2026-09-25.log');
    const foreignPlain = path.join(tempDir, 'other-service.log');

    fs.writeFileSync(oldLog, 'old content');
    fs.writeFileSync(foreignDated, 'foreign dated');
    fs.writeFileSync(foreignPlain, 'foreign plain');

    const oldTime = new Date(2026, 8, 20, 10, 0, 0);
    fs.utimesSync(oldLog, oldTime, oldTime);
    fs.utimesSync(foreignDated, oldTime, oldTime);
    fs.utimesSync(foreignPlain, oldTime, oldTime);

    const deleted = cleanOldLogFiles(tempDir, 3, now);

    assert.deepEqual(deleted, ['novastory.log']);
    const remaining = fs.readdirSync(tempDir);
    assert.ok(!remaining.includes('novastory.log'));
    assert.ok(remaining.includes('other-service.2026-09-25.log'));
    assert.ok(remaining.includes('other-service.log'));

    fs.writeFileSync(recentLog, 'recent content');
    const recentTime = new Date(2026, 8, 30, 10, 0, 0);
    fs.utimesSync(recentLog, recentTime, recentTime);
    const secondPass = cleanOldLogFiles(tempDir, 3, now);
    assert.deepEqual(secondPass, []);
    assert.ok(fs.existsSync(recentLog));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cleanOldLogFiles handles non-existent directory gracefully', () => {
  const nonExistentDir = path.join(os.tmpdir(), 'non-existent-log-dir-xyz123');
  const deleted = cleanOldLogFiles(nonExistentDir, 3);
  assert.deepEqual(deleted, []);
});

test('logger logs messages properly', () => {
  assert.ok(typeof logger.info === 'function');
  assert.ok(typeof logger.error === 'function');
  assert.ok(typeof logger.warn === 'function');
  assert.ok(typeof logger.debug === 'function');

  // Should not throw
  logger.info('Test logger info message');
});
