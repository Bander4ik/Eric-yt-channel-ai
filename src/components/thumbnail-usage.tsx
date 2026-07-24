"use client";

import { useEffect, useState } from "react";

/**
 * What thumbnail generation has cost so far on the active channel.
 *
 * Mirrors claude-usage / apify-usage. The one difference worth knowing:
 * a run whose provider reported no usage numbers is counted separately
 * rather than folded in at the estimated price — otherwise the total
 * would quietly drift from the real invoice.
 */

type Spend = {
  totalCents: number;
  runs: number;
  runsWithoutCost: number;
  images: number;
};

export function ThumbnailUsage({ channelId }: { channelId?: string | null }) {
  const [spend, setSpend] = useState<Spend | null>(null);

  useEffect(() => {
    void (async () => {
      const params = new URLSearchParams({ limit: "1" });
      if (channelId) params.set("channelId", channelId);
      const r = await fetch(`/api/thumbnails/runs?${params}`, {
        cache: "no-store",
      });
      if (!r.ok) return;
      const j = (await r.json()) as { spend: Spend };
      setSpend(j.spend);
    })();
  }, [channelId]);

  if (!spend || spend.runs === 0) return null;

  return (
    <p className="text-xs text-muted-foreground">
      {spend.runs} run{spend.runs === 1 ? "" : "s"} · {spend.images} image
      {spend.images === 1 ? "" : "s"} ·{" "}
      {spend.totalCents > 0
        ? `$${(spend.totalCents / 100).toFixed(2)} recorded`
        : "no cost recorded"}
      {spend.runsWithoutCost > 0 && (
        <>
          {" "}
          ({spend.runsWithoutCost} run
          {spend.runsWithoutCost === 1 ? "" : "s"} reported no usage data)
        </>
      )}
    </p>
  );
}
