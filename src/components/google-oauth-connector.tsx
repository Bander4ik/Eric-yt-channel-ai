"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Lightbulb,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";

type Status = {
  configured: boolean;
  connected: boolean;
  expiresAt: number | null;
  refreshTokenAgeDays: number | null;
  publishedProven: boolean;
  scopes: string[];
};

type ConfigInfo = {
  configured: boolean;
  clientIdPreview: string | null;
};

export function GoogleOAuthConnector() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  // The redirect URI Google must be told about is whatever origin this page
  // is actually served from. Hardcoding a port sent anyone who moved the app
  // to another port (port.txt) into a redirect_uri_mismatch with no clue why.
  const [redirectUri, setRedirectUri] = useState(
    "http://localhost:3010/api/youtube/oauth/callback"
  );
  useEffect(() => {
    if (typeof window !== "undefined") {
      setRedirectUri(`${window.location.origin}/api/youtube/oauth/callback`);
    }
  }, []);
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [savedCfg, setSavedCfg] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [sRes, cRes] = await Promise.all([
        fetch("/api/youtube/oauth/status"),
        fetch("/api/youtube/oauth/config"),
      ]);
      const s = (await sRes.json()) as Status;
      const c = (await cRes.json()) as ConfigInfo;
      setStatus(s);
      setCfg(c);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load status");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Pick up ?oauth=connected|error&reason=... after the callback redirect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const qp = new URLSearchParams(window.location.search);
    const oauth = qp.get("oauth");
    if (!oauth) return;
    if (oauth === "connected") {
      setInfo(t.googleOAuth.connectedJustNow);
    } else if (oauth === "error") {
      setErr(`${t.googleOAuth.errorPrefix}: ${qp.get("reason") ?? "unknown"}`);
    }
    // Clean URL so a refresh doesn't re-trigger the message.
    qp.delete("oauth");
    qp.delete("reason");
    const rest = qp.toString();
    const url = `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", url);
    load();
  }, [load, t.googleOAuth.connectedJustNow, t.googleOAuth.errorPrefix]);

  const saveConfig = async () => {
    if (!clientId.trim() || !clientSecret.trim()) return;
    setSavingCfg(true);
    setErr(null);
    setInfo(null);
    try {
      const res = await fetch("/api/youtube/oauth/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setErr(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setClientId("");
      setClientSecret("");
      setSavedCfg(true);
      setTimeout(() => setSavedCfg(false), 1800);
      await load();
    } finally {
      setSavingCfg(false);
    }
  };

  const connect = () => {
    // Full redirect to our /start endpoint, which 302s to Google.
    window.location.href = "/api/youtube/oauth/start";
  };

  const disconnect = async () => {
    if (!window.confirm(t.googleOAuth.disconnectConfirm)) return;
    setDisconnecting(true);
    setErr(null);
    setInfo(null);
    try {
      await fetch("/api/youtube/oauth/disconnect", { method: "POST" });
      await load();
      setInfo(t.googleOAuth.disconnected);
    } finally {
      setDisconnecting(false);
    }
  };

  const connected = !!status?.connected;
  const configured = !!cfg?.configured;
  const ageDays = status?.refreshTokenAgeDays;
  // The 7-day clock only exists for apps left on "Testing". Once a refresh
  // has proven the app is published we say nothing at all — an evergreen
  // "reconnect soon" on a healthy connection just teaches people to ignore us.
  const published = !!status?.publishedProven;
  const ageNote = !published && typeof ageDays === "number" && ageDays > 7
    ? t.googleOAuth.likelyExpired
    : !published && typeof ageDays === "number" && ageDays >= 5
      ? t.googleOAuth.stillTesting
      : published
        ? t.googleOAuth.publishedNoExpiry
        : null;
  const warn = !published && typeof ageDays === "number" && ageDays >= 5;

  return (
    <Card id="youtube-analytics">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>{t.googleOAuth.title}</CardTitle>
          <CardDescription className="mt-1">{t.googleOAuth.subtitle}</CardDescription>
        </div>
        <span
          className={
            connected
              ? "inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400"
              : "inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          }
        >
          {connected && <Check className="h-3 w-3" />}
          {connected ? t.integrations.status.connected : t.integrations.status.notConnected}
        </span>
      </CardHeader>

      <CardContent className="space-y-4">
        <details className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none text-foreground">
            {t.googleOAuth.howToTitle}
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 leading-relaxed">
            <li>{t.googleOAuth.howStep1}</li>
            <li>{t.googleOAuth.howStep2}</li>
            <li>
              {t.googleOAuth.howStep3}{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                {redirectUri}
              </code>
            </li>
            <li>{t.googleOAuth.howStep4}</li>
            <li>{t.googleOAuth.howStep5}</li>
          </ol>
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {t.googleOAuth.openConsole}
            <ExternalLink className="h-3 w-3" />
          </a>
        </details>

        {/* Real-world tips — every single one of these has bitten us at
            least once during setup. Left closed by default so the happy
            path stays uncluttered, but there's a visible "Important tips"
            lightbulb summary so users notice it exists. */}
        <details className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 text-foreground">
            <Lightbulb className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            {t.googleOAuth.tipsTitle}
          </summary>
          <ul className="mt-2 space-y-2 leading-relaxed">
            <li>
              <strong className="text-foreground">Brand Account / Manager access:</strong>{" "}
              {t.googleOAuth.tipBrandAccount}
            </li>
            <li>
              <strong className="text-foreground">Manager vs Owner (revenue):</strong>{" "}
              {t.googleOAuth.tipManagerLimitations}
            </li>
            <li>
              <strong className="text-foreground">The &quot;app isn&apos;t verified&quot; screen:</strong>{" "}
              {t.googleOAuth.tipUnverifiedScreen}
            </li>
            <li>
              <strong className="text-foreground">Where scopes live:</strong>{" "}
              {t.googleOAuth.tipWhereScopes}
            </li>
            <li>
              <strong className="text-foreground">7-day refresh expiry:</strong>{" "}
              {t.googleOAuth.tipRefreshTokenExpiry}
            </li>
          </ul>
        </details>

        {/* Client credentials */}
        <div className="space-y-2">
          <Label htmlFor="google-client-id">{t.googleOAuth.clientIdLabel}</Label>
          <Input
            id="google-client-id"
            placeholder="xxxxxxxx.apps.googleusercontent.com"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {cfg?.clientIdPreview && !clientId && (
            <p className="text-xs text-muted-foreground">
              {t.googleOAuth.currentClientId}: <span className="font-mono">{cfg.clientIdPreview}</span>
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="google-client-secret">{t.googleOAuth.clientSecretLabel}</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="google-client-secret"
                type={showSecret ? "text" : "password"}
                placeholder="GOCSPX-..."
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowSecret((s) => !s)}
                className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                aria-label={showSecret ? t.integrations.hideKey : t.integrations.showKey}
              >
                {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button
              onClick={saveConfig}
              disabled={savingCfg || !clientId.trim() || !clientSecret.trim()}
            >
              {savingCfg ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : savedCfg ? (
                <>
                  <Check className="h-4 w-4" />
                  {t.integrations.saved}
                </>
              ) : (
                t.integrations.save
              )}
            </Button>
          </div>
        </div>

        {/* Connect / Reconnect / Disconnect controls */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            onClick={connect}
            disabled={!configured}
            variant={connected ? "outline" : "default"}
            className="gap-2"
          >
            {connected ? (
              <>
                <RefreshCw className="h-4 w-4" />
                {t.googleOAuth.reconnect}
              </>
            ) : (
              <>
                <LogIn className="h-4 w-4" />
                {t.googleOAuth.connect}
              </>
            )}
          </Button>
          {connected && (
            <Button
              onClick={disconnect}
              variant="ghost"
              disabled={disconnecting}
              className="gap-2 text-muted-foreground hover:text-destructive"
            >
              {disconnecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
              {t.googleOAuth.disconnect}
            </Button>
          )}
          {!configured && (
            <p className="text-xs text-muted-foreground">{t.googleOAuth.saveCredsFirst}</p>
          )}
        </div>

        {/* Connected info */}
        {connected && status && (
          <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs">
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span className="font-medium">{t.googleOAuth.activeSession}</span>
            </div>
            {typeof ageDays === "number" && (
              <div className={warn ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
                {t.googleOAuth.refreshAge.replace("{n}", String(ageDays))}
                {ageNote && ` ${ageNote}`}
              </div>
            )}
            {status.scopes.length > 0 && (
              <div className="text-muted-foreground">
                {t.googleOAuth.scopesLabel}:{" "}
                <span className="font-mono">{status.scopes.join(" ")}</span>
              </div>
            )}
          </div>
        )}

        {info && (
          <div className="flex items-start gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-2 text-xs text-green-700 dark:text-green-400">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{info}</span>
          </div>
        )}
        {err && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
