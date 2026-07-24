import "server-only";
import { getSetting, setSetting } from "./db";

/**
 * The survivable background job pattern, factored out.
 *
 * Long operations in this app are fire-and-forget on the server with
 * their state in the `settings` table, polled by the client. That's a
 * deliberate choice made after a bug report: the OCR batch used to
 * stream progress over SSE, so navigating away unmounted the reader, the
 * connection dropped, and the loop died mid-batch. Now the loop finishes
 * regardless of who is watching.
 *
 * Three properties every job here inherits:
 *   - a duplicate start returns 409 instead of running twice;
 *   - a job whose process died (server restart, crash) is considered
 *     stale after STALE_JOB_MS and no longer blocks a new start;
 *   - progress is persisted after every unit of work, so a fresh page
 *     load shows accurate totals rather than starting from zero.
 *
 * `/api/videos/thumbnails-ocr` implements this inline and predates this
 * helper; it is left alone deliberately — rewriting a working, battle-
 * tested route to share code isn't worth the regression risk.
 */

export const STALE_JOB_MS = 2 * 60 * 60 * 1000;

export type SettingsJob = {
  running: boolean;
  done: number;
  failed: number;
  total: number;
  startedAt: number;
  finishedAt?: number;
  /** Free-form label so the UI can say what it's doing right now. */
  stage?: string;
  lastError?: string | null;
  /** Set by the job when it produced something worth linking to. */
  resultId?: number | null;
};

export function readJob(key: string): SettingsJob | null {
  const raw = getSetting(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SettingsJob;
  } catch {
    return null;
  }
}

export function writeJob(key: string, job: SettingsJob): void {
  setSetting(key, JSON.stringify(job));
}

/** True when a job is genuinely still running (not a stale corpse). */
export function isJobRunning(key: string): boolean {
  const job = readJob(key);
  return !!job?.running && Date.now() - job.startedAt < STALE_JOB_MS;
}

export function startJob(
  key: string,
  total: number,
  stage?: string
): SettingsJob {
  const job: SettingsJob = {
    running: true,
    done: 0,
    failed: 0,
    total,
    startedAt: Date.now(),
    stage,
    lastError: null,
  };
  writeJob(key, job);
  return job;
}

export function progressJob(
  key: string,
  patch: Partial<SettingsJob>
): void {
  const current = readJob(key);
  if (!current) return;
  writeJob(key, { ...current, ...patch });
}

export function finishJob(
  key: string,
  patch: Partial<SettingsJob> = {}
): void {
  const current = readJob(key) ?? {
    running: false,
    done: 0,
    failed: 0,
    total: 0,
    startedAt: Date.now(),
  };
  writeJob(key, {
    ...current,
    ...patch,
    running: false,
    finishedAt: Date.now(),
  });
}

/**
 * Job keys are per channel. Without that, generating for channel B would
 * report channel A's progress in the UI, and the 409 guard would block
 * two different channels from working at once for no reason.
 */
export function jobKey(base: string, channelId: string): string {
  return `${base}.${channelId}`;
}
