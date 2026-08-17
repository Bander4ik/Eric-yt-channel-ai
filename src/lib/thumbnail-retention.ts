import "server-only";
import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  deleteThumbnailVariants,
  listPrunableThumbnails,
  UNPICKED_KEEP_DAYS,
} from "./db";
import { log } from "./logger";

/**
 * Clearing out covers nobody chose.
 *
 * There is no scheduler here and there is not going to be one. This app
 * runs on the user's own laptop: they double-click start.command, work,
 * and close the window. Nothing of ours is alive at 3am to run a nightly
 * job, and a rule that depends on the app being open is a rule that
 * quietly never fires.
 *
 * So the sweep happens when the app is used — on the request that opens
 * the Thumbnails tab. That makes the rule the screen can honestly state:
 * covers you did not pick are cleared the next time you open the app
 * after they turn a week old. If the app sits closed for a month,
 * nothing is deleted and nothing has grown either; the first visit back
 * tidies up.
 *
 * Anything picked survives. Choosing a cover is the one signal that says
 * "this is the output, not a candidate", and deleting a picked cover has
 * to stay a deliberate act by the person who picked it.
 */

export type PruneResult = { variants: number; files: number; bytes: number };

export function pruneUnpickedCovers(
  days = UNPICKED_KEEP_DAYS
): PruneResult {
  const { ids, files } = listPrunableThumbnails(days);
  if (ids.length === 0) return { variants: 0, files: 0, bytes: 0 };

  let removed = 0;
  let bytes = 0;
  for (const rel of files) {
    const abs = path.join(DATA_DIR, rel);
    try {
      bytes += fs.statSync(abs).size;
      fs.unlinkSync(abs);
      removed++;
    } catch {
      // Already gone, or never written because the run failed. The row
      // is what matters; a missing file is not an error worth surfacing.
    }
  }

  // Rows go last. If the process dies mid-sweep the files are gone and
  // the rows point at nothing — which the UI already survives (a variant
  // with no file renders as an error card) — whereas the other order
  // would leave files with no row and nothing to ever find them again.
  const variants = deleteThumbnailVariants(ids);

  log.info("thumbnails", "Cleared covers nobody picked", {
    variants,
    files: removed,
    mb: Math.round((bytes / 1048576) * 10) / 10,
    olderThanDays: days,
  });
  return { variants, files: removed, bytes };
}
