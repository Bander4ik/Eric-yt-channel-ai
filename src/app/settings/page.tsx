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
import { ClaudeUsage } from "@/components/claude-usage";
import { ApifyUsage } from "@/components/apify-usage";
import { DeepgramUsage } from "@/components/deepgram-usage";
import { ImageProviderSettings } from "@/components/image-provider-settings";

type Name = "claude" | "deepgram" | "apify" | "youtube" | "google_gemini";

type StatusMap = Record<
  Name,
  { hasKey: boolean; masked: string; enabled: boolean }
>;

type Help = { title: string; steps: string[]; link: string; linkLabel: string };
type Item = { name: Name; label: string; desc: string; placeholder: string; help: Help };

/**
 * Settings — merged with the former /integrations page (2026-07).
 *
 * Everything a client needs lives on ONE page now, ordered by how badly
 * you need it: Required to work → Channel → Optional → Usage →
 * Appearance. The former Integrations page was a tall stack of large
 * cards with help steps permanently expanded — this rebuilds every key
 * as a single compact row (name + status + masked value + set/replace),
 * with help collapsed into a native <details>. Sections 3-5 are
 * collapsed by default so the page opens on what actually matters.
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

      {/* 1. Required to work — always open, the minimum a client needs. */}
      <section className="space-y-2">
        <SectionHeader
          title="Required to work"
          desc="A YouTube Data API key to load videos and stats, plus one AI provider to power chat / Hook Lab / advisor."
        />
        <div className="space-y-2">
          <KeyRow
            item={items.youtube}
            status={status?.youtube}
            onSave={(v) => saveIntegration("youtube", v)}
          />
          <AiProviderPicker
            claudeItem={items.claude}
            geminiItem={items.google_gemini}
            status={status}
            onSave={saveIntegration}
          />
          <details className="rounded-md border border-border">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium hover:bg-muted/30">
              Google OAuth (optional, recommended) — Studio Analytics &amp; revenue
            </summary>
            <div className="border-t border-border/60 p-3">
              <GoogleOAuthConnector />
            </div>
          </details>
        </div>
      </section>

      {/* 2. Channel */}
      <section className="space-y-2">
        <SectionHeader title="Channel" desc="Bind and manage your YouTube channel." />
        <YouTubeChannelBinder hasKey={!!status?.youtube?.hasKey} />
        <YouTubeCookies />
      </section>

      {/* 3. Optional — collapsed, quiet by default. */}
      <details className="rounded-md border border-border/60 bg-muted/10">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
          Optional
        </summary>
        <div className="space-y-3 border-t border-border/60 p-3">
          <p className="text-xs text-muted-foreground">
            Add when you want the feature. Deepgram unlocks transcription for
            videos without YouTube captions. Apify is the competitor-sync
            fallback when no YouTube Data API key is set.
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
          <ImageProviderSettings />
        </div>
      </details>

      {/* 4. Usage — collapsed, quiet by default. */}
      <details className="rounded-md border border-border/60 bg-muted/10">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
          Usage
        </summary>
        <div className="space-y-3 border-t border-border/60 p-3">
          <ClaudeUsage enabled={!!status?.claude?.hasKey} />
          <ApifyUsage enabled={!!status?.apify?.hasKey} />
          <DeepgramUsage enabled={!!status?.deepgram?.hasKey} />
        </div>
      </details>

      {/* 5. Appearance — collapsed, quiet by default. */}
      <details className="rounded-md border border-border/60 bg-muted/10">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
          Appearance
        </summary>
        <div className="space-y-3 border-t border-border/60 p-3">
          <div>
            <div className="mb-2 text-sm font-medium">{t.settings.theme}</div>
            <div className="flex gap-2">
              <Button
                variant={theme === "light" ? "default" : "outline"}
                size="sm"
                onClick={() => setTheme("light")}
              >
                {t.settings.themeLight}
              </Button>
              <Button
                variant={theme === "dark" ? "default" : "outline"}
                size="sm"
                onClick={() => setTheme("dark")}
              >
                {t.settings.themeDark}
              </Button>
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">Optional sections</div>
            <p className="mb-2 text-xs text-muted-foreground">
              Parts of the app you can hide if they don&apos;t fit how you work.
              Nothing here is deleted — turning one back on restores it with
              whatever was in it.
            </p>
            <div className="space-y-2">
              <ToggleRow
                label="Ideas board"
                description="Show the Board tab in Ideation. It's a kanban for moving ideas through scripting, editing and publishing — worth having if a team works in the app with you, and mostly dead weight if you plan alone or already use Trello or Notion. Your cards are kept either way."
                value={showIdeasBoard}
                onChange={setShowIdeasBoard}
              />
              <ToggleRow
                label="Editor billing card"
                description="Show the editor payouts widget on the Dashboard. Useful only if you pay an editor per video."
                value={showEditorBilling}
                onChange={setShowEditorBilling}
              />
              <ToggleRow
                label="Logs in sidebar"
                description="Show the Logs entry in the left navigation. The /logs route always works via direct URL — this just controls visibility."
                value={showLogs}
                onChange={setShowLogs}
              />
            </div>
          </div>
        </div>
      </details>
    </div>
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
