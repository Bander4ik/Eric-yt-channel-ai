"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Check, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n/provider";
import { useTheme } from "@/lib/theme-provider";
import { useUiPref } from "@/lib/ui-prefs";
import { cn } from "@/lib/utils";
import { YouTubeChannelBinder } from "@/components/youtube-channel-binder";
import { YouTubeCookies } from "@/components/youtube-cookies";
import { GoogleOAuthConnector } from "@/components/google-oauth-connector";
import { ImageProviderSettings } from "@/components/image-provider-settings";

type Name = "claude" | "deepgram" | "apify" | "youtube" | "google_gemini";

type StatusMap = Record<
  Name,
  { hasKey: boolean; masked: string; enabled: boolean }
>;

type Help = { title: string; steps: string[]; link: string; linkLabel: string };
type Item = { name: Name; label: string; desc: string; placeholder: string; help: Help };

/**
 * Settings — one page, three questions, in the order a new user hits
 * them: what do I have to fill in, which channels am I working on, and
 * everything else.
 *
 * Rebuilt 2026-08-16 after a client said the app had "too much stuff, I
 * don't know how to use it". The page had grown to 37 controls in five
 * collapsible sections (Required / Channel / Optional / Usage /
 * Appearance) — a filing system rather than an answer. Cut here: the
 * Claude ledger with its 100 past turns, token counters and
 * Clear-history button; the Apify and Deepgram credit bars (their
 * "limit" was a number the user invented — it capped nothing); and the
 * section wrappers themselves. What replaced the whole Usage section is
 * one line of spend beside the AI key.
 *
 * The image-provider form moved UP out of "Optional": it is the fuel for
 * the thumbnail generator, which is the feature clients actually open
 * the app for.
 *
 * The API contract is untouched: GET/POST /api/integrations,
 * {integrations: Record<name, {hasKey, masked, enabled}>}.
 */
export default function SettingsPage() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  // Optional UI surfaces — hidden by default to keep the app simple for
  // non-technical users. Power users (and Vlad's own workflows) flip
  // them on here.
  const [showEditorBilling, setShowEditorBilling] = useUiPref("showEditorBilling");
  const [showLogs, setShowLogs] = useUiPref("showLogs");
  const [showIdeasBoard, setShowIdeasBoard] = useUiPref("showIdeasBoard");

  const [status, setStatus] = useState<StatusMap | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/integrations");
    const data = (await res.json()) as { integrations: StatusMap };
    setStatus(data.integrations);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveIntegration = useCallback(
    async (name: Name, value: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch("/api/integrations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, api_key: value }),
        });
        if (!res.ok) {
          let msg = `Save failed (HTTP ${res.status})`;
          try {
            const data = (await res.json()) as { error?: string };
            if (data?.error) msg = `Save failed: ${data.error}`;
          } catch {
            /* server returned a non-JSON crash page — keep the HTTP code */
          }
          return { ok: false, error: msg };
        }
        await load();
        return { ok: true };
      } catch {
        // fetch() itself threw → the local server isn't reachable.
        return {
          ok: false,
          error:
            "Couldn't reach the local server. Make sure the app window (the terminal that started it) is still open, then try again.",
        };
      }
    },
    [load]
  );

  // Source-of-truth item data, reusing the same i18n strings the old
  // Integrations page used (label/desc/placeholder/help) — no new
  // copy needed.
  const items: Record<Name, Item> = {
    claude: {
      name: "claude",
      label: t.integrations.claude.name,
      desc: t.integrations.claude.desc,
      placeholder: t.integrations.claude.placeholder,
      help: {
        title: t.integrations.claude.helpTitle,
        steps: t.integrations.claude.helpSteps,
        link: t.integrations.claude.helpLink,
        linkLabel: t.integrations.claude.helpLinkLabel,
      },
    },
    google_gemini: {
      name: "google_gemini",
      label: t.integrations.gemini.name,
      desc: t.integrations.gemini.desc,
      placeholder: t.integrations.gemini.placeholder,
      help: {
        title: t.integrations.gemini.helpTitle,
        steps: t.integrations.gemini.helpSteps,
        link: t.integrations.gemini.helpLink,
        linkLabel: t.integrations.gemini.helpLinkLabel,
      },
    },
    youtube: {
      name: "youtube",
      label: t.integrations.youtube.name,
      desc: t.integrations.youtube.desc,
      placeholder: t.integrations.youtube.placeholder,
      help: {
        title: t.integrations.youtube.helpTitle,
        steps: t.integrations.youtube.helpSteps,
        link: t.integrations.youtube.helpLink,
        linkLabel: t.integrations.youtube.helpLinkLabel,
      },
    },
    deepgram: {
      name: "deepgram",
      label: t.integrations.deepgram.name,
      desc: t.integrations.deepgram.desc,
      placeholder: t.integrations.deepgram.placeholder,
      help: {
        title: t.integrations.deepgram.helpTitle,
        steps: t.integrations.deepgram.helpSteps,
        link: t.integrations.deepgram.helpLink,
        linkLabel: t.integrations.deepgram.helpLinkLabel,
      },
    },
    apify: {
      name: "apify",
      label: t.integrations.apify.name,
      desc: t.integrations.apify.desc,
      placeholder: t.integrations.apify.placeholder,
      help: {
        title: t.integrations.apify.helpTitle,
        steps: t.integrations.apify.helpSteps,
        link: t.integrations.apify.helpLink,
        linkLabel: t.integrations.apify.helpLinkLabel,
      },
    },
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="mb-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.settings.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.settings.subtitle}</p>
      </header>

      {/* 1. Fill these in — the three keys that make the app work. */}
      <section className="space-y-2">
        <SectionHeader
          title="Fill these in"
          desc="Three keys and the app works: YouTube to load your videos, one AI to think, one image provider to draw thumbnails. Nothing further down this page is required."
        />
        <div className="space-y-2">
          <KeyRow
            item={items.youtube}
            status={status?.youtube}
            onSave={(v) => saveIntegration("youtube", v)}
          />
          <div className="space-y-1">
            <AiProviderPicker
              claudeItem={items.claude}
              geminiItem={items.google_gemini}
              status={status}
              onSave={saveIntegration}
            />
            {/* The whole Usage section came down to this one line. A
                running cost is the only usage number that can make
                somebody stop and change something; token counts and
                cache-read totals cannot. */}
            <AiSpendLine enabled={!!status?.claude?.hasKey} />
          </div>
          <ImageProviderSettings />
        </div>
      </section>

      {/* 2. Your channels */}
      <section className="space-y-2">
        <SectionHeader
          title="Your channels"
          desc="Paste a channel link to add it. Connecting Google is what unlocks the numbers YouTube keeps private: revenue, audience, and how often people click your thumbnail."
        />
        <YouTubeChannelBinder hasKey={!!status?.youtube?.hasKey} />
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium hover:bg-muted/30">
            Connect Google — revenue, audience and thumbnail click-through
          </summary>
          <div className="border-t border-border/60 p-3">
            <GoogleOAuthConnector />
          </div>
        </details>
        <ShortsAnalysisSetting />
      </section>

      {/* 3. Everything else — one line plus one drawer.

          This used to be three collapsed sections (Optional, Usage,
          Appearance) holding 20-odd controls. A client who runs his
          channels alone said the app had "too much stuff, I don't know
          how to use it", and a settings page that files 37 controls into
          five drawers is a filing system, not an answer. What survives
          here either changes something visible in one click (theme) or
          is a genuine escape hatch a few people need (the drawer). The
          usage ledgers are gone: 100 rows of past AI turns, token
          counters and credit bars for keys most users never set. */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
          <span className="text-sm font-medium">{t.settings.theme}</span>
          <Button
            variant={theme === "light" ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setTheme("light")}
          >
            {t.settings.themeLight}
          </Button>
          <Button
            variant={theme === "dark" ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setTheme("dark")}
          >
            {t.settings.themeDark}
          </Button>
        </div>

        <details className="rounded-md border border-border/60 bg-muted/10">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
            Advanced — extra keys, and parts of the app you can hide
          </summary>
          <div className="space-y-3 border-t border-border/60 p-3">
            <p className="text-xs text-muted-foreground">
              Nothing here is needed to use the app. Deepgram transcribes the
              rare video that has no YouTube captions — captions are free and
              come first. Apify only steps in for competitor sync when no
              YouTube key is set.
            </p>
            <KeyRow
              item={items.deepgram}
              status={status?.deepgram}
              onSave={(v) => saveIntegration("deepgram", v)}
            />
            <KeyRow
              item={items.apify}
              status={status?.apify}
              onSave={(v) => saveIntegration("apify", v)}
            />
            <YouTubeCookies />
            <div className="pt-1">
              <div className="mb-2 text-sm font-medium">
                Parts of the app you can bring back
              </div>
              <p className="mb-2 text-xs text-muted-foreground">
                All three are off by default. Nothing is deleted — turning one
                on restores it with whatever was in it.
              </p>
              <div className="space-y-2">
                <ToggleRow
                  label="Ideas board"
                  description="A kanban that moves ideas through scripting, editing and publishing. Worth having when a team works in the app with you; dead weight when you plan alone, because you are the only one who can move a card. Your cards are kept either way."
                  value={showIdeasBoard}
                  onChange={setShowIdeasBoard}
                />
                <ToggleRow
                  label="Editor billing card"
                  description="A payouts widget on the Dashboard. Useful only if you pay an editor per video."
                  value={showEditorBilling}
                  onChange={setShowEditorBilling}
                />
                <ToggleRow
                  label="Logs in sidebar"
                  description="The raw activity stream, with the exact error when something fails. The /logs address always works — this only puts it in the menu."
                  value={showLogs}
                  onChange={setShowLogs}
                />
              </div>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}

/**
 * One line of spend beside the AI key: what the app has cost in the last
 * 24 hours and in total. This is all that is left of a Usage section
 * that used to carry per-turn rows, token counts and a Clear-history
 * button — none of which change what anybody does next.
 *
 * Claude-only, because only Claude reports usage back to us; with a
 * Gemini key the line simply does not render rather than showing a
 * confident zero.
 */
function AiSpendLine({ enabled }: { enabled: boolean }) {
  const [data, setData] = useState<{
    totalCostMillicents: number;
    last24hCostMillicents: number;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/claude/usage");
        if (!res.ok || !alive) return;
        const j = (await res.json()) as {
          totalCostMillicents: number;
          last24hCostMillicents: number;
        };
        if (alive) setData(j);
      } catch {
        /* local server unreachable — the key row above says enough */
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled]);

  if (!enabled || !data) return null;

  const usd = (millicents: number): string => {
    const v = millicents / 100_000;
    if (v < 0.01) return `$${v.toFixed(4)}`;
    if (v < 1) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
  };

  return (
    <p className="px-1 text-xs text-muted-foreground">
      AI spend: {usd(data.last24hCostMillicents)} in the last 24h ·{" "}
      {usd(data.totalCostMillicents)} total
    </p>
  );
}

function SectionHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
    </div>
  );
}

/**
 * One integration key = one compact row: name, connected/not-connected
 * dot, masked value, and a Set/Replace button that reveals an inline
 * input. Help steps are collapsed behind a native <details> — they used
 * to be a permanently-expanded block that dominated the old page.
 */
function KeyRow({
  item,
  status,
  onSave,
}: {
  item: Item;
  status?: { hasKey: boolean; masked: string };
  onSave: (value: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = !!status?.hasKey;

  const save = async () => {
    setSaving(true);
    setError(null);
    const res = await onSave(value);
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? "Save failed");
      return;
    }
    setValue("");
    setEditing(false);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1800);
  };

  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            connected ? "bg-green-500" : "bg-muted-foreground/40"
          )}
          aria-hidden
        />
        <span className="text-sm font-medium">{item.label}</span>
        {connected && (
          <span className="font-mono text-xs text-muted-foreground">{status?.masked}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {justSaved && (
            <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setEditing((v) => !v)}
          >
            {connected ? "Replace" : "Set key"}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{item.desc}</p>

      {editing && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={show ? "text" : "password"}
                placeholder={item.placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                aria-label={show ? "Hide" : "Show"}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button size="sm" onClick={save} disabled={saving || !value.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </div>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none text-foreground/80 hover:text-foreground">
          {item.help.title}
        </summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 leading-relaxed">
          {item.help.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <a
          href={item.help.link}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-primary hover:underline"
        >
          {item.help.linkLabel}
          <ExternalLink className="h-3 w-3" />
        </a>
      </details>
    </div>
  );
}

/**
 * Provider choice that swaps which single field you fill — same
 * interaction ImageProviderSettings already uses for image providers.
 * Choosing Claude or Gemini reveals ONE key row, never both at once.
 * Whichever provider already has a key preselects.
 */
function AiProviderPicker({
  claudeItem,
  geminiItem,
  status,
  onSave,
}: {
  claudeItem: Item;
  geminiItem: Item;
  status: StatusMap | null;
  onSave: (name: Name, value: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [provider, setProvider] = useState<"claude" | "google_gemini">("claude");
  const inited = useRef(false);

  useEffect(() => {
    if (inited.current || !status) return;
    inited.current = true;
    if (status.google_gemini?.hasKey && !status.claude?.hasKey) {
      setProvider("google_gemini");
    }
  }, [status]);

  const item = provider === "claude" ? claudeItem : geminiItem;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Label className="text-xs text-muted-foreground">AI provider</Label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as "claude" | "google_gemini")}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="claude">Claude (Anthropic)</option>
          <option value="google_gemini">Google Gemini</option>
        </select>
      </div>
      <KeyRow
        key={provider}
        item={item}
        status={status?.[provider]}
        onSave={(v) => onSave(provider, v)}
      />
    </div>
  );
}

/**
 * Generic on/off row. Pure presentation — wired to ui-prefs.tsx
 * via two `useUiPref` hooks in the parent component. We render an
 * accessible button rather than the native checkbox so the click
 * target matches the rest of our Settings buttons.
 */
/**
 * "Ignore Shorts in analysis" — per-channel, lives in the Channel
 * section rather than under Optional on purpose: it changes what every
 * number on every other screen means, which is not an "optional extra".
 *
 * The cutoff control only appears once the switch is on; a cutoff with
 * the filter off is a dead control that invites the user to fiddle with
 * a setting that does nothing.
 */
function ShortsAnalysisSetting() {
  const { t } = useI18n();
  const s = t.settings.shorts;
  const [loaded, setLoaded] = useState(false);
  const [noChannel, setNoChannel] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [seconds, setSeconds] = useState(60);
  const [customText, setCustomText] = useState("60");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/analysis/shorts");
        if (!alive) return;
        if (res.status === 400) {
          setNoChannel(true);
          setLoaded(true);
          return;
        }
        const data = (await res.json()) as {
          excludeShorts: boolean;
          maxSeconds: number;
        };
        if (!alive) return;
        setEnabled(data.excludeShorts);
        setSeconds(data.maxSeconds);
        setCustomText(String(data.maxSeconds));
        setLoaded(true);
      } catch {
        if (alive) {
          setError(s.error);
          setLoaded(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [s.error]);

  const save = useCallback(
    async (patch: { excludeShorts?: boolean; maxSeconds?: number }) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/analysis/shorts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = (await res.json()) as {
          excludeShorts?: boolean;
          maxSeconds?: number;
          error?: string;
        };
        if (!res.ok) {
          setError(data?.error ?? s.error);
          return;
        }
        if (typeof data.excludeShorts === "boolean") setEnabled(data.excludeShorts);
        if (typeof data.maxSeconds === "number") {
          setSeconds(data.maxSeconds);
          setCustomText(String(data.maxSeconds));
        }
        setSavedAt(Date.now());
      } catch {
        setError(s.error);
      } finally {
        setBusy(false);
      }
    },
    [s.error]
  );

  if (!loaded) return null;

  if (noChannel) {
    return (
      <div className="rounded-md border border-border p-3">
        <div className="text-sm font-medium">{s.label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{s.noChannel}</div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{s.label}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{s.description}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {!busy && savedAt > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <Check className="h-3 w-3" /> {s.saved}
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant={enabled ? "default" : "outline"}
            disabled={busy}
            aria-pressed={enabled}
            onClick={() => save({ excludeShorts: !enabled })}
          >
            {enabled ? "On" : "Off"}
          </Button>
        </div>
      </div>

      {enabled && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <Label className="text-xs font-medium">{s.cutoffLabel}</Label>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={seconds === 60 ? "default" : "outline"}
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => save({ maxSeconds: 60 })}
            >
              {s.option60}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={seconds === 180 ? "default" : "outline"}
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => save({ maxSeconds: 180 })}
            >
              {s.option180}
            </Button>
            <span className="text-xs text-muted-foreground">{s.optionCustom}:</span>
            <Input
              type="number"
              min={1}
              max={600}
              inputMode="numeric"
              className="h-7 w-20 text-xs"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onBlur={() => {
                const n = Number(customText);
                if (!Number.isInteger(n) || n < 1 || n > 600) {
                  setCustomText(String(seconds));
                  return;
                }
                if (n !== seconds) save({ maxSeconds: n });
              }}
              aria-label={s.cutoffLabel}
            />
            <span className="text-xs text-muted-foreground">{s.customSuffix}</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{s.cutoffHelp}</p>
        </div>
      )}

      <p className="mt-2 text-xs text-muted-foreground">{s.affects}</p>
      <p className="mt-1 text-xs text-muted-foreground">{s.notAffected}</p>
      {error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      <Button
        type="button"
        size="sm"
        variant={value ? "default" : "outline"}
        onClick={() => onChange(!value)}
        className="shrink-0"
        aria-pressed={value}
      >
        {value ? "On" : "Off"}
      </Button>
    </div>
  );
}
