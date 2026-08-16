import {
  isReachReportIngested,
  markReachReportIngested,
  saveReachRows,
} from "./db";
import { getValidAccessToken } from "./google-oauth";
import { log } from "./logger";

/**
 * YouTube REPORTING API — bulk CSV reports.
 *
 * Not to be confused with `yt-analytics.ts`, which talks to the YouTube
 * ANALYTICS API (targeted queries, answers immediately). These are two
 * different services with two different shapes, and the difference is
 * the whole reason this file exists:
 *
 *   Analytics API   ask a question -> get rows back now
 *   Reporting API   ask ONCE for a standing job -> Google generates a
 *                   CSV per day -> you download the days you missed
 *
 * We are here for exactly one thing: **thumbnail click-through rate**.
 * It is not available in the Analytics API at all (checked against
 * Google's metric reference — the word "thumbnail" does not appear on
 * it), and it is not public data, so no Data API key can reach it. It
 * arrived on 2026-01-15 in the Reporting API as the "reach" reports:
 *
 *   channel_reach_basic_a1
 *     dimensions: date, channel_id, video_id
 *     metrics:    video_thumbnail_impressions,
 *                 video_thumbnail_impressions_ctr
 *
 * Two properties of this API drive the design here, and both matter for
 * an app that lives on someone's laptop rather than on a server:
 *
 * 1. Google generates nothing until a job exists. Historical backfill
 *    only reaches 30 days before the job was created, so the job should
 *    be created as early as possible — every day without one is a day of
 *    CTR nobody can ever recover. Hence `ensureReachJob` runs on sync
 *    rather than waiting for the user to open some particular screen.
 *
 * 2. Generated reports sit on Google's side for 60 days. The user's
 *    machine does NOT need to be on when a report is generated — it just
 *    needs to be opened within 60 days to collect them. That is what
 *    makes this workable for a local app that is closed most of the time:
 *    we catch up on whatever accumulated, however long it has been.
 */

const BASE = "https://youtubereporting.googleapis.com/v1";

/** The report that carries thumbnail impressions + CTR per video per day. */
export const REACH_REPORT_TYPE = "channel_reach_basic_a1";

/** Our job's display name — how we recognise our own job on re-runs. */
const JOB_NAME = "YouTube Channel AI VIP — reach (thumbnail CTR)";

export type ReachRow = {
  date: string; // YYYYMMDD as delivered by the API
  videoId: string;
  impressions: number;
  /** 0..100 as delivered by YouTube (a percentage, not a fraction). */
  ctr: number;
};

export type ReportMeta = {
  id: string;
  jobId: string;
  startTime: string;
  endTime: string;
  createTime: string;
  downloadUrl: string;
};

type JobResource = { id: string; reportTypeId: string; name?: string };

/**
 * Thrown when the channel has no usable Google connection. Callers treat
 * this as "skip quietly", not as a failure: most installs will not have
 * connected Google, and CTR is an enhancement, never a prerequisite.
 */
export class ReachUnavailableError extends Error {}

async function authorized(
  url: string,
  channelId: string | null,
  init?: RequestInit
): Promise<Response> {
  let token: string;
  try {
    token = await getValidAccessToken(channelId);
  } catch (err) {
    throw new ReachUnavailableError(
      err instanceof Error ? err.message : "No Google connection for this channel."
    );
  }
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Find our reach job for this channel, creating it if absent.
 *
 * Idempotent by report type: we look for ANY existing job with the reach
 * report type rather than matching on name, because a job created by a
 * previous version (or by the user in some other tool) is just as good
 * and creating a second one would duplicate the same data.
 */
export async function ensureReachJob(channelId: string | null): Promise<string> {
  const listRes = await authorized(`${BASE}/jobs`, channelId);
  if (!listRes.ok) {
    const reason = await readError(listRes);
    // 401/403 here means the connection cannot do this — not a bug.
    if (listRes.status === 401 || listRes.status === 403) {
      throw new ReachUnavailableError(reason);
    }
    throw new Error(`Could not list reporting jobs: ${reason}`);
  }
  const listed = (await listRes.json()) as { jobs?: JobResource[] };
  const existing = (listed.jobs ?? []).find(
    (j) => j.reportTypeId === REACH_REPORT_TYPE
  );
  if (existing) return existing.id;

  const createRes = await authorized(`${BASE}/jobs`, channelId, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reportTypeId: REACH_REPORT_TYPE, name: JOB_NAME }),
  });
  if (!createRes.ok) {
    const reason = await readError(createRes);
    if (createRes.status === 401 || createRes.status === 403) {
      throw new ReachUnavailableError(reason);
    }
    throw new Error(`Could not create the reach reporting job: ${reason}`);
  }
  const job = (await createRes.json()) as JobResource;
  log.info("analytics", "Created YouTube reach reporting job", {
    channelId,
    jobId: job.id,
    reportType: REACH_REPORT_TYPE,
  });
  return job.id;
}

/**
 * Every report currently downloadable for this job, newest last.
 *
 * We do not filter server-side by time: the caller skips what it has
 * already ingested by report id, which is more robust than a date
 * cursor. Backfill reports for days we already have are re-delivered by
 * design ("backfill data replaces previously delivered data"), and the
 * row upsert handles that correctly.
 */
export async function listReachReports(
  jobId: string,
  channelId: string | null
): Promise<ReportMeta[]> {
  const out: ReportMeta[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${BASE}/jobs/${jobId}/reports`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await authorized(url.toString(), channelId);
    if (!res.ok) {
      const reason = await readError(res);
      if (res.status === 401 || res.status === 403) {
        throw new ReachUnavailableError(reason);
      }
      throw new Error(`Could not list reach reports: ${reason}`);
    }
    const body = (await res.json()) as {
      reports?: Array<{
        id: string;
        jobId: string;
        startTime: string;
        endTime: string;
        createTime: string;
        downloadUrl: string;
      }>;
      nextPageToken?: string;
    };
    for (const r of body.reports ?? []) {
      if (r.downloadUrl) out.push(r);
    }
    pageToken = body.nextPageToken;
  } while (pageToken);

  out.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return out;
}

/** Download one report's CSV body. */
export async function downloadReachReport(
  downloadUrl: string,
  channelId: string | null
): Promise<string> {
  // `alt=media` is what turns the resource URL into the file itself.
  const url = new URL(downloadUrl);
  url.searchParams.set("alt", "media");
  const res = await authorized(url.toString(), channelId, {
    headers: { Accept: "text/csv" },
  });
  if (!res.ok) {
    const reason = await readError(res);
    if (res.status === 401 || res.status === 403) {
      throw new ReachUnavailableError(reason);
    }
    throw new Error(`Could not download a reach report: ${reason}`);
  }
  return res.text();
}

/**
 * Parse a reach CSV into rows.
 *
 * Columns are matched BY HEADER NAME, never by position: Google adds
 * columns to report versions over time, and a positional parser silently
 * reads the wrong number the day they do. A report for a day with no
 * data is delivered as a header row and nothing else — that is normal
 * and yields zero rows, not an error.
 */
export function parseReachCsv(csv: string): ReachRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);

  const iDate = col("date");
  const iVideo = col("video_id");
  const iImpr = col("video_thumbnail_impressions");
  const iCtr = col("video_thumbnail_impressions_ctr");

  if (iDate < 0 || iVideo < 0 || iImpr < 0 || iCtr < 0) {
    throw new Error(
      `Reach report is missing expected columns. Got: ${header.join(", ")}`
    );
  }

  const rows: ReachRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const videoId = (cells[iVideo] ?? "").trim();
    if (!videoId) continue;
    const impressions = Number(cells[iImpr]);
    const ctr = Number(cells[iCtr]);
    rows.push({
      date: (cells[iDate] ?? "").trim(),
      videoId,
      impressions: Number.isFinite(impressions) ? impressions : 0,
      ctr: Number.isFinite(ctr) ? ctr : 0,
    });
  }
  return rows;
}

export type ReachSyncResult = {
  /** False when there is no Google connection — not an error. */
  available: boolean;
  jobId: string | null;
  /** Reports newly downloaded on this run. */
  reportsIngested: number;
  /** Reports already held, skipped without downloading. */
  reportsSkipped: number;
  rowsIngested: number;
  /** Set when the job exists but has produced nothing yet. */
  note?: string;
};

/**
 * Bring this channel's CTR up to date: make sure the job exists, then
 * download whatever days accumulated since last time.
 *
 * Safe to call often and safe to call on a machine that has been off for
 * a month — reports live on Google's side for 60 days, so an app that is
 * opened once in a while collects the whole gap in one pass. Nothing
 * here needs a scheduler.
 *
 * Never throws for the ordinary "no Google connected" case: callers
 * treat `available: false` as "carry on with views".
 */
export async function syncReachReports(
  channelId: string | null
): Promise<ReachSyncResult> {
  let jobId: string;
  try {
    jobId = await ensureReachJob(channelId);
  } catch (err) {
    if (err instanceof ReachUnavailableError) {
      return {
        available: false,
        jobId: null,
        reportsIngested: 0,
        reportsSkipped: 0,
        rowsIngested: 0,
        note: err.message,
      };
    }
    throw err;
  }

  const reports = await listReachReports(jobId, channelId);
  if (reports.length === 0) {
    return {
      available: true,
      jobId,
      reportsIngested: 0,
      reportsSkipped: 0,
      rowsIngested: 0,
      note: "The reporting job exists but Google has not generated any report yet. The first one can take up to 48 hours.",
    };
  }

  let ingested = 0;
  let skipped = 0;
  let rowCount = 0;

  for (const report of reports) {
    if (isReachReportIngested(report.id)) {
      skipped++;
      continue;
    }
    const csv = await downloadReachReport(report.downloadUrl, channelId);
    const rows = parseReachCsv(csv);
    const saved = saveReachRows(rows, channelId);
    markReachReportIngested({
      reportId: report.id,
      channelId,
      jobId,
      startTime: report.startTime,
      endTime: report.endTime,
      rowsIngested: saved,
    });
    ingested++;
    rowCount += saved;
  }

  if (ingested > 0) {
    log.info("analytics", "Reach reports ingested", {
      channelId,
      jobId,
      reports: ingested,
      skipped,
      rows: rowCount,
    });
  }

  return {
    available: true,
    jobId,
    reportsIngested: ingested,
    reportsSkipped: skipped,
    rowsIngested: rowCount,
  };
}
