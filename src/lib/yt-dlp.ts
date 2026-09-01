import "server-only";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { DATA_DIR } from "./db";

/**
 * Our own yt-dlp runner, replacing the `youtube-dl-exec` package.
 *
 * Why we stopped using the package: it did its work at INSTALL time, and
 * both halves of that failed on real client machines.
 *
 *   1. Its `preinstall` script refused to install unless it found Python
 *      >= 3.9 on the machine — even though nothing here ever runs Python.
 *      A Windows client without Python simply could not install the app.
 *   2. Its `postinstall` script downloaded the yt-dlp binary through
 *      `api.github.com`, which is a different host from `github.com` and is
 *      blocked or throttled on plenty of networks. The same client, past
 *      the Python problem, then hit a 10s connect timeout there.
 *
 * Both failures happened before the app existed, so a person could not even
 * reach a screen that would explain them — `npm install` just died. Worse,
 * both are failures of an OPTIONAL feature (transcripts) taking the entire
 * install down with it.
 *
 * So: no install-time work at all. The binary is fetched lazily, the first
 * time something actually needs a transcript, from
 * `github.com/yt-dlp/yt-dlp/releases/latest/download/...` — a plain
 * redirect on the main host, no API involved. If that fails the app keeps
 * working and only transcripts are unavailable, with a message that says so.
 */

/** Where a downloaded binary lives. Beside the database, so it survives updates. */
const BIN_DIR = path.join(DATA_DIR, "bin");

const BINARY_NAME = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

/**
 * Release asset names per platform. These are stable, human-facing download
 * URLs — `/releases/latest/download/<asset>` 302-redirects to the current
 * release. No `api.github.com`, no JSON, no token.
 */
function assetName(): string {
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  return "yt-dlp_linux";
}

const DOWNLOAD_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName()}`;

/** Thrown when we have no binary and could not get one. */
export class YtDlpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YtDlpUnavailableError";
  }
}

/**
 * Places we accept an existing binary from, in order. The `node_modules`
 * entry is for machines installed before this change — their copy is
 * perfectly good and re-downloading it would be rude.
 */
function existingBinary(): string | null {
  const candidates = [
    process.env.YTDLP_PATH,
    path.join(BIN_DIR, BINARY_NAME),
    path.join(process.cwd(), "node_modules", "youtube-dl-exec", "bin", BINARY_NAME),
  ].filter((p): p is string => !!p);

  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * Download once, even if three transcript requests arrive together — a
 * half-written binary is worse than a slow one.
 */
let inFlight: Promise<string> | null = null;

async function downloadBinary(): Promise<string> {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const target = path.join(BIN_DIR, BINARY_NAME);
  // Write to a temp name and rename: a killed download must never leave
  // something that looks like a working binary.
  const tmp = path.join(BIN_DIR, `.${BINARY_NAME}.partial`);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // An idle watchdog, not a total deadline. The asset is 18-40 MB
    // depending on platform, so a single overall timeout would fail
    // deterministically on a slow-but-working connection — the exact
    // people this whole change is meant to unblock. Instead we abort only
    // when nothing has arrived for a while.
    const IDLE_MS = 60_000;
    const controller = new AbortController();
    let idle: NodeJS.Timeout = setTimeout(() => controller.abort(), IDLE_MS);
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), IDLE_MS);
    };

    try {
      const res = await fetch(DOWNLOAD_URL, {
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} from ${DOWNLOAD_URL}`);
      }
      const parts: Buffer[] = [];
      let received = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        parts.push(Buffer.from(chunk));
        received += chunk.length;
        touch();
      }
      const buf = Buffer.concat(parts, received);
      // A redirect page or an error body would be tiny; the real binary is
      // ~10 MB. Refuse to install something that obviously isn't it.
      if (buf.length < 1_000_000) {
        throw new Error(`downloaded file is only ${buf.length} bytes, not a yt-dlp build`);
      }
      fs.writeFileSync(tmp, buf);
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, target);
      return target;
    } catch (err) {
      lastError = err;
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best-effort */
      }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    } finally {
      clearTimeout(idle);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new YtDlpUnavailableError(
    `Could not download the transcript engine (yt-dlp) from github.com: ${detail}. ` +
      `Everything else in the app works — only transcripts need it. ` +
      `If your network blocks GitHub, download ${assetName()} manually from ` +
      `https://github.com/yt-dlp/yt-dlp/releases/latest and put it in ${BIN_DIR} ` +
      `as ${BINARY_NAME}.`
  );
}

/** Resolve a usable binary path, downloading it the first time if needed. */
export async function ytDlpPath(): Promise<string> {
  const found = existingBinary();
  if (found) return found;
  if (!inFlight) {
    inFlight = downloadBinary().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** True when a transcript could be fetched right now without a download. */
export function ytDlpIsReady(): boolean {
  return existingBinary() !== null;
}

/**
 * Turn `{ dumpSingleJson: true, subLang: "en", noWarnings: true }` into
 * `["--dump-single-json", "--sub-lang", "en", "--no-warnings"]`.
 *
 * Same shape `youtube-dl-exec` accepted, so call sites did not have to
 * change: camelCase keys, `true` means a bare flag, `false` means the
 * `--no-` form, arrays repeat the flag.
 */
function toArgs(flags: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === null) continue;
    const flag = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    if (value === true) {
      args.push(`--${flag}`);
    } else if (value === false) {
      args.push(`--no-${flag}`);
    } else if (Array.isArray(value)) {
      for (const v of value) args.push(`--${flag}`, String(v));
    } else {
      args.push(`--${flag}`, String(value));
    }
  }
  return args;
}

/** Error shaped like the one call sites already read (stderr, exitCode). */
interface YtDlpExecError extends Error {
  stderr: string;
  stdout: string;
  exitCode: number | null;
  shortMessage: string;
}

/**
 * Run yt-dlp. Returns parsed JSON when `dumpSingleJson` is set (matching
 * what `youtube-dl-exec` did), otherwise raw stdout.
 */
export async function youtubeDl(
  url: string,
  flags: Record<string, unknown> = {}
): Promise<unknown> {
  const bin = await ytDlpPath();
  const args = [...toArgs(flags), url];

  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        bin,
        args,
        {
          // A --dump-single-json of a long video with every format listed
          // runs to several megabytes; the 1 MB default truncates it and
          // the JSON parse then fails for a reason that looks unrelated.
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          timeout: 5 * 60_000,
        },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: number | string };
            const wrapped = new Error(err.message) as YtDlpExecError;
            wrapped.name = "YtDlpError";
            wrapped.stdout = String(stdout ?? "");
            wrapped.stderr = String(stderr ?? "");
            wrapped.exitCode = typeof e.code === "number" ? e.code : null;
            wrapped.shortMessage = `yt-dlp exited with ${e.code ?? "an error"}`;
            reject(wrapped);
            return;
          }
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        }
      );
    }
  );

  if (flags.dumpSingleJson) {
    try {
      return JSON.parse(stdout);
    } catch (err) {
      const wrapped = new Error(
        `yt-dlp returned output that is not JSON: ${(err as Error).message}`
      ) as YtDlpExecError;
      wrapped.name = "YtDlpError";
      wrapped.stdout = stdout.slice(0, 2000);
      wrapped.stderr = stderr;
      wrapped.exitCode = 0;
      wrapped.shortMessage = "yt-dlp returned non-JSON output";
      throw wrapped;
    }
  }
  return stdout;
}

/**
 * Streaming variant, for the audio download in deepgram.ts: yt-dlp writes
 * the audio to stdout and the caller reads it into RAM.
 *
 * Deliberately synchronous, unlike `youtubeDl()` above. The caller needs the
 * child process object immediately so it can attach `stdout`/`stderr`
 * listeners before any data arrives, and it also awaits that same object to
 * learn the exit code — a promise resolving to a thenable child would be
 * unwrapped by `await` and collapse those two steps into one. So the binary
 * has to be on disk already: call `await ytDlpPath()` first.
 */
export type YtDlpProcess = ChildProcess & PromiseLike<void>;

export function exec(
  url: string,
  flags: Record<string, unknown> = {},
  spawnOptions: { stdio?: Array<"ignore" | "pipe"> } = {}
): YtDlpProcess {
  const bin = existingBinary();
  if (!bin) {
    throw new YtDlpUnavailableError(
      `The transcript engine (yt-dlp) is not installed yet. It downloads on ` +
        `first use — call ytDlpPath() before exec().`
    );
  }

  const child = spawn(bin, [...toArgs(flags), url], {
    stdio: spawnOptions.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // This is the path that moves tens of megabytes over a CDN, and no
    // caller passes an abort signal. Without a ceiling a wedged transfer
    // holds the request open forever; 20 minutes is far above a real
    // hour-long audio download and far below "forever".
    timeout: 20 * 60_000,
    killSignal: "SIGKILL",
  }) as YtDlpProcess;

  // Make the child awaitable the way the execa-based package was, so the
  // call site can `await subprocess` and catch a non-zero exit.
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const e = new Error(
        `yt-dlp exited with ${code ?? signal ?? "an error"}`
      ) as Error & { exitCode: number | null };
      e.exitCode = code;
      reject(e);
    });
  });
  child.then = done.then.bind(done);

  return child;
}

const api = Object.assign(youtubeDl, { exec, ytDlpPath, ytDlpIsReady });
export default api;

/** Exposed for diagnostics pages. */
export const YT_DLP_BIN_DIR = BIN_DIR;
export const YT_DLP_DOWNLOAD_URL = DOWNLOAD_URL;
