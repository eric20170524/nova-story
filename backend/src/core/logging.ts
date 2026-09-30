import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { getLogDirectory } from './paths';

export const logDir = getLogDirectory();

/** pino-roll daily files: novastory.yyyy-MM-dd.N.log. The live file is novastory.log. */
const NOVASTORY_ROLLING_LOG = /^novastory\.\d{4}-\d{2}-\d{2}\.\d+\.log$/;
const NOVASTORY_ACTIVE_LOG = 'novastory.log';

export function isNovaStoryLogFile(file: string): boolean {
  return file === NOVASTORY_ACTIVE_LOG || NOVASTORY_ROLLING_LOG.test(file);
}

/**
 * Returns the configured log retention days.
 * Configurable via `LOG_RETENTION_DAYS`, `NOVASTORY_LOG_RETENTION_DAYS`, or `LOG_MAX_DAYS`.
 * Defaults to 3 days.
 */
export function getLogRetentionDays(): number {
  const envVal =
    process.env.LOG_RETENTION_DAYS ||
    process.env.NOVASTORY_LOG_RETENTION_DAYS ||
    process.env.LOG_MAX_DAYS;
  if (!envVal) return 3;
  const parsed = parseInt(envVal, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
}

/**
 * Cleans up log files older than the retention period.
 * Keeps log files for the current day and the preceding (retentionDays - 1) days.
 *
 * @param directory Directory containing log files (defaults to logDir)
 * @param retentionDays Number of days of logs to retain (defaults to configured retention days)
 * @param now Reference date for calculating cutoff (defaults to current time)
 * @returns Array of removed log file names
 */
export function cleanOldLogFiles(
  directory: string = logDir,
  retentionDays: number = getLogRetentionDays(),
  now: Date = new Date()
): string[] {
  if (!fs.existsSync(directory)) return [];

  const deletedFiles: string[] = [];
  // Retention cutoff: start of (today - retentionDays + 1)
  const cutoffDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (retentionDays - 1),
    0,
    0,
    0,
    0
  );
  const cutoffTime = cutoffDate.getTime();

  try {
    const entries = fs.readdirSync(directory);
    for (const file of entries) {
      if (!isNovaStoryLogFile(file)) continue;

      const filePath = path.join(directory, file);
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;

        const dateMatch = file.match(/(\d{4})-(\d{2})-(\d{2})/);
        let fileTime: number;

        if (dateMatch && dateMatch[1] && dateMatch[2] && dateMatch[3]) {
          const year = parseInt(dateMatch[1], 10);
          const month = parseInt(dateMatch[2], 10);
          const day = parseInt(dateMatch[3], 10);
          fileTime = new Date(
            year,
            month - 1,
            day,
            0,
            0,
            0,
            0
          ).getTime();
        } else {
          fileTime = stats.mtimeMs;
        }

        if (fileTime < cutoffTime) {
          fs.unlinkSync(filePath);
          deletedFiles.push(file);
        }
      } catch {
        // Skip files that fail inspection or removal
      }
    }
  } catch {
    // Ignore directory read errors
  }

  return deletedFiles;
}

// Perform initial cleanup of expired log files upon module load
cleanOldLogFiles(logDir, getLogRetentionDays());

// Periodic daily cleanup in long-running processes
if (typeof setInterval !== 'undefined') {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    cleanOldLogFiles(logDir, getLogRetentionDays());
  }, ONE_DAY_MS).unref();
}

let pinoRollTarget = 'pino-roll';
try {
  pinoRollTarget = require.resolve('pino-roll');
} catch {
  pinoRollTarget = 'pino-roll';
}

const retentionDays = getLogRetentionDays();

// Create a Pino logger instance with daily rolling and retention limit
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets: [
      {
        target: 'pino-pretty', // Console output
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
        },
      },
      {
        target: pinoRollTarget, // Daily rolling file output
        options: {
          file: path.join(logDir, 'novastory.log'),
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          mkdir: true,
          limit: {
            count: retentionDays,
            removeOtherLogFiles: true,
          },
        },
      },
    ],
  },
});
