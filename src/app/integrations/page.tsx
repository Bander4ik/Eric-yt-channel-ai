import { redirect } from "next/navigation";

// The Integrations page was merged into Settings (2026-07) — one page,
// no separate "Integrations" entry. This route stays only so a
// bookmark or an old link doesn't 404; it forwards straight to
// /settings, which now covers every key + channel binder + usage
// widget that used to live here.
export default function IntegrationsRedirect() {
  redirect("/settings");
}
