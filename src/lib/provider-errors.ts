/**
 * Turning a provider's error into something a channel owner can act on.
 *
 * A client's screen showed this, in red, as the entire explanation:
 *
 *   400 {"type":"error","error":{"type":"invalid_request_error",
 *   "message":"Your credit balance is too low to access the Anthropic
 *   API. Please go to Plans & Billing to upgrade or purchase credits."},
 *   "request_id":"req_011Ce8o7Bj7syY65msFedtmP"}
 *
 * The answer is in there — his account is out of money — but it is
 * wrapped in three layers of machine punctuation, and the people using
 * this app are video makers, not engineers. Worse, a blob like that
 * reads as "the app is broken" rather than "top up your account", and
 * the difference decides whether the next message is a bug report or a
 * two-minute fix.
 *
 * Deliberately narrow: only failures whose remedy is unambiguous get
 * rewritten. Anything else is passed through untouched, because an
 * invented explanation is worse than an ugly true one — and the original
 * text is always kept alongside, so nothing is hidden from someone who
 * does want to read it.
 */

export type ExplainedError = {
  /** What to tell the user. */
  message: string;
  /** The provider's own words, kept for anyone who wants them. */
  detail: string | null;
};

type Rule = {
  match: RegExp;
  /** Which service the money or the key belongs to. */
  explain: (raw: string) => string;
};

const RULES: Rule[] = [
  {
    match: /credit balance is too low|insufficient[_ ]quota|billing[_ ]hard[_ ]limit/i,
    explain: () =>
      "Your AI account is out of credit, so the analysis could not run. Top it up in that provider's billing page and press the button again — nothing was lost, and you were not charged for this attempt. If you would rather not top it up, add a Google Gemini key in Settings and the app will use that instead; Gemini has a free tier.",
  },
  {
    match: /invalid[_ ]api[_ ]key|authentication[_ ]error|401|unauthorized|API key not valid/i,
    explain: () =>
      "The AI key was rejected. Open Settings and paste it again — the usual cause is a key that was copied with a space at one end, or one that has since been revoked in the provider's console.",
  },
  {
    match: /rate[_ ]limit|429|too many requests/i,
    explain: () =>
      "The AI provider is asking us to slow down — too many requests in a short time. Wait a minute and press the button again; this is temporary and costs nothing.",
  },
  {
    match: /overloaded|529|high demand|service unavailable|503/i,
    explain: () =>
      "The AI provider is overloaded right now, which happens in bursts and passes. Try again in a few minutes — nothing about your channel or your keys is wrong.",
  },
  {
    match: /flagged as sensitive|content polic|safety system|moderation/i,
    explain: () =>
      "The image provider refused this one on its content policy — usually a subject it will not draw rather than anything wrong with your channel. Rewording the title or generating a different format is normally enough; you were not charged for the refused image.",
  },
];

export function explainProviderError(raw: unknown): ExplainedError {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  if (!text.trim()) {
    return { message: "Something failed without saying what.", detail: null };
  }
  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return { message: rule.explain(text), detail: text };
    }
  }
  return { message: text, detail: null };
}

/** One string for places that can only show one — explanation first. */
export function explainProviderErrorText(raw: unknown): string {
  const { message, detail } = explainProviderError(raw);
  return detail ? `${message}\n\n(${detail})` : message;
}
