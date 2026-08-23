import "server-only";
import { getCached, getIntegration, getSetting, setCached, setSetting } from "./db";

const NEXLEV_BASE_URL = "https://prod.dashboard.nexlev.io";
const DISCOVERY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const DISCOVERY_CACHE_PREFIX = "nexlev.discovery.";
const DISCOVERY_DAYS = 30;
const MIN_MONTHLY_VIEWS = 300_000;
const MIN_OUTLIER_SCORE = 2;
const MIN_SUBSCRIBERS = 1_000;
const MAX_SUBSCRIBERS = 100_000;

type JsonRecord = Record<string, unknown>;

export type OpportunityVideo = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  views: number;
  publishedAt: number;
  outlierScore: number;
  label: "Very strong" | "Strong" | "Above average";
};

export type CompetitorOpportunity = {
  channelId: string;
  title: string;
  handle: string | null;
  avatarUrl: string | null;
  subscriberCount: number | null;
  similarity: number | null;
  recentOutlierCount: number;
  reason: string;
  videos: OpportunityVideo[];
};

export type DiscoveryPayload = {
  referenceChannelId: string;
  fetchedAt: number;
  opportunities: CompetitorOpportunity[];
};

export class NexLevError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "NexLevError";
  }
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(obj: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const message = value.find(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      );
      if (message) return message.trim();
    }
  }
  return null;
}

function numberValue(obj: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function parseDate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  const relative = trimmed.match(/^(\d+)\s*(minute|hour|day|week)s?\s*ago$/i);
  if (!relative) return null;
  const amount = Number(relative[1]);
  const unit = relative[2].toLowerCase();
  const seconds =
    unit === "minute"
      ? amount * 60
      : unit === "hour"
        ? amount * 3600
        : unit === "day"
          ? amount * 86400
          : amount * 604800;
  return Math.floor(Date.now() / 1000) - seconds;
}

function findArray(value: unknown, preferredKeys: string[], depth = 0): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = record(value);
  if (!obj || depth > 4) return [];
  for (const key of preferredKeys) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  for (const child of Object.values(obj)) {
    const found = findArray(child, preferredKeys, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function channelId(obj: JsonRecord): string | null {
  const value = stringValue(obj, [
    "channelId",
    "channel_id",
    "youtubeChannelId",
    "youtube_channel_id",
    "id",
  ]);
  return value?.startsWith("UC") ? value : null;
}

function scoreLabel(score: number): OpportunityVideo["label"] {
  if (score >= 4) return "Very strong";
  if (score >= 2.5) return "Strong";
  return "Above average";
}

async function nexlevFetch(path: string, apiKey: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${NEXLEV_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = record(body);
    throw new NexLevError(
      stringValue(detail ?? {}, ["message", "error", "detail"]) ??
        `NexLev request failed (${response.status})`,
      response.status
    );
  }
  return body;
}

function normalizeVideo(raw: unknown): OpportunityVideo | null {
  const obj = record(raw);
  if (!obj) return null;
  const videoId = stringValue(obj, ["videoId", "video_id", "youtubeVideoId", "id"]);
  const title = stringValue(obj, ["title", "videoTitle", "name"]);
  const publishedAt = parseDate(
    obj.publishedAt ?? obj.published_at ?? obj.publishedDate ?? obj.uploadDate ?? obj.date
  );
  if (!videoId || !title || !publishedAt) return null;
  const score =
    numberValue(obj, ["outlierScore", "outlier_score", "multiplier", "ratio", "score"]) ??
    1.5;
  return {
    videoId,
    title,
    thumbnailUrl: stringValue(obj, ["thumbnailUrl", "thumbnail_url", "thumbnail", "image"]),
    views: Math.max(0, numberValue(obj, ["views", "viewCount", "view_count"]) ?? 0),
    publishedAt,
    outlierScore: Math.max(1, score),
    label: scoreLabel(Math.max(1, score)),
  };
}

function normalizeChannel(raw: unknown): {
  channelId: string;
  title: string;
  handle: string | null;
  avatarUrl: string | null;
  subscriberCount: number | null;
  similarity: number | null;
} | null {
  const obj = record(raw);
  if (!obj) return null;
  const about = record(obj.about);
  const metadata = about ?? obj;
  const id = channelId(obj) ?? channelId(metadata);
  if (!id) return null;
  return {
    channelId: id,
    title: stringValue(metadata, ["title", "channelName", "channel_name", "name"]) ?? id,
    handle: stringValue(metadata, ["handle", "channelHandle", "channel_handle", "username"]),
    avatarUrl: firstImageUrl(metadata.avatar) ?? stringValue(metadata, ["avatarUrl", "avatar_url", "thumbnail"]),
    subscriberCount: numberValue(metadata, ["subscriberCount", "subscriber_count", "subscribers"]),
    similarity:
      numberValue(obj, ["similarityScore", "similarity_score", "similarity"]) ??
      numberValue(metadata, ["similarityScore", "similarity_score", "similarity"]),
  };
}

function firstImageUrl(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const image = record(item);
    const url = image ? stringValue(image, ["url", "src"]) : null;
    if (url) return url;
  }
  return null;
}

function enrichChannel(
  channel: NonNullable<ReturnType<typeof normalizeChannel>>,
  raw: unknown
): NonNullable<ReturnType<typeof normalizeChannel>> {
  const obj = record(raw);
  if (!obj) return channel;
  return {
    ...channel,
    title: stringValue(obj, ["title", "channelName", "channel_name", "name"]) ?? channel.title,
    handle:
      stringValue(obj, ["handle", "channelHandle", "channel_handle", "username"]) ?? channel.handle,
    avatarUrl:
      firstImageUrl(obj.avatar) ??
      stringValue(obj, ["avatarUrl", "avatar_url", "thumbnail", "image"]) ??
      channel.avatarUrl,
    subscriberCount:
      numberValue(obj, ["subscriberCount", "subscriber_count", "subscribers"]) ??
      channel.subscriberCount,
  };
}

function hiddenKey(channelId: string): string {
  return `${DISCOVERY_CACHE_PREFIX}hidden.${channelId}`;
}

function cacheKey(channelId: string): string {
  return `${DISCOVERY_CACHE_PREFIX}${channelId}`;
}

export function hiddenDiscoveryChannels(channelId: string): Set<string> {
  const raw = getSetting(hiddenKey(channelId));
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function hideDiscoveryChannel(ownerChannelId: string, discoveredChannelId: string): void {
  const hidden = hiddenDiscoveryChannels(ownerChannelId);
  hidden.add(discoveredChannelId);
  setSetting(hiddenKey(ownerChannelId), JSON.stringify([...hidden]));
}

export function getDiscoveryPayload(ownerChannelId: string): DiscoveryPayload | null {
  const cached = getCached<DiscoveryPayload>(cacheKey(ownerChannelId));
  if (!cached) return null;
  const hidden = hiddenDiscoveryChannels(ownerChannelId);
  return {
    ...cached,
    opportunities: cached.opportunities.filter((item) => !hidden.has(item.channelId)),
  };
}

export async function discoverOpportunities(
  ownerChannelId: string,
  apiKey: string
): Promise<DiscoveryPayload> {
  const similarPayload = await nexlevFetch("/api/external/similar-channels/search", apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId: ownerChannelId, channelType: "all", level: 1 }),
  });
  const candidates = findArray(similarPayload, ["channels", "results", "similarChannels", "data"])
    .map(normalizeChannel)
    .filter((item): item is NonNullable<ReturnType<typeof normalizeChannel>> => item !== null)
    .filter((item) => item.channelId !== ownerChannelId);
  candidates.sort((a, b) => {
    const aInRange = a.subscriberCount !== null && a.subscriberCount >= MIN_SUBSCRIBERS && a.subscriberCount <= MAX_SUBSCRIBERS;
    const bInRange = b.subscriberCount !== null && b.subscriberCount >= MIN_SUBSCRIBERS && b.subscriberCount <= MAX_SUBSCRIBERS;
    return Number(bInRange) - Number(aInRange);
  });

  const opportunities: CompetitorOpportunity[] = [];
  for (const candidate of candidates) {
    try {
      const aboutPayload = await nexlevFetch(
        `/api/external/channels/about?id=${encodeURIComponent(candidate.channelId)}`,
        apiKey
      );
      const about = record(aboutPayload);
      const enrichedCandidate = enrichChannel(candidate, about?.about ?? aboutPayload);

      const videosPayload = await nexlevFetch(
        `/api/external/channels/videos?id=${encodeURIComponent(candidate.channelId)}&sort=latest`,
        apiKey
      );
      const channelVideos = findArray(videosPayload, ["videos", "data", "results"])
        .map(normalizeVideo)
        .filter((item): item is OpportunityVideo => item !== null);
      const cutoff = Math.floor(Date.now() / 1000) - DISCOVERY_DAYS * 86400;
      const recentViews = channelVideos
        .filter((video) => video.publishedAt >= cutoff)
        .reduce((sum, video) => sum + video.views, 0);
      const hasRecentViews = recentViews >= MIN_MONTHLY_VIEWS;
      const hasTargetSubscriberCount =
        enrichedCandidate.subscriberCount !== null &&
        enrichedCandidate.subscriberCount >= MIN_SUBSCRIBERS &&
        enrichedCandidate.subscriberCount <= MAX_SUBSCRIBERS;

      let videos: OpportunityVideo[] = [];
      try {
        const outlierPayload = await nexlevFetch(
          `/api/external/channels/outliers?id=${encodeURIComponent(candidate.channelId)}&maxVideos=50&minOutlierThreshold=${MIN_OUTLIER_SCORE}`,
          apiKey
        );
        videos = findArray(outlierPayload, ["outliers", "videos", "results", "data"])
          .map(normalizeVideo)
          .filter((item): item is OpportunityVideo => item !== null)
          .filter((item) => item.outlierScore >= MIN_OUTLIER_SCORE)
          .sort((a, b) => b.outlierScore - a.outlierScore || b.views - a.views)
          .slice(0, 3);
      } catch {
        // The other two signals can still qualify a channel if outlier data is unavailable.
      }
      if (!hasRecentViews && !hasTargetSubscriberCount) continue;
      const activity = videos.reduce((sum, video) => sum + video.outlierScore, 0);
      const similarity = candidate.similarity ?? 0;
      const matchedCriteria = [
        hasRecentViews ? `300K+ views in 30 days` : null,
        hasTargetSubscriberCount ? `1K–100K subscribers` : null,
      ].filter((item): item is string => item !== null);
      const reason = matchedCriteria.join(" · ");
      opportunities.push({
        ...enrichedCandidate,
        recentOutlierCount: videos.length,
        reason,
        videos,
        // Keep demand ahead of raw similarity and subscriber count.
        // The value is intentionally internal; the UI uses labels only.
        similarity: similarity + activity * 0.01,
      });
    } catch {
      // One unavailable candidate should not discard the entire discovery run.
    }
  }

  opportunities.sort((a, b) => {
    const aDemand = a.videos.reduce((sum, video) => sum + video.outlierScore, 0);
    const bDemand = b.videos.reduce((sum, video) => sum + video.outlierScore, 0);
    return bDemand - aDemand || (b.similarity ?? 0) - (a.similarity ?? 0);
  });
  const payload: DiscoveryPayload = {
    referenceChannelId: ownerChannelId,
    fetchedAt: Math.floor(Date.now() / 1000),
    opportunities,
  };
  setCached(cacheKey(ownerChannelId), payload, DISCOVERY_CACHE_TTL_SECONDS);
  return getDiscoveryPayload(ownerChannelId) ?? payload;
}

export function nexlevConfigured(): boolean {
  return !!getIntegration("nexlev")?.api_key;
}

export function nexlevApiKey(): string | null {
  return getIntegration("nexlev")?.api_key ?? null;
}
