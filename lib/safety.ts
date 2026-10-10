// Carried over from the Kaizen lead-responder repo's lib/safety.ts, minus
// its "outside standard residential script" rule: dumpster rentals and
// contractor jobs are the whole point of this bot.

import type { SafetyVerdict } from "./types.js";

// Exact-message match only (industry-standard SMS opt-out keywords — carriers
// treat these the same way). Deliberately NOT matched as a prefix/substring:
// "cancel my service" must NOT silently opt someone out of texts when what
// they actually want is a human to process a service cancellation — see the
// "service cancellation request" escalation pattern below instead.
const OPT_OUT_EXACT_KEYWORDS = [
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "opt out", "optout",
];

// Natural-language opt-out phrasing — real people rarely just text the bare
// keyword. Matched anywhere in the message, biased toward over-catching:
// treating a borderline message as opt-out costs nothing (we just stop
// texting them), while missing a real one is a compliance problem.
const OPT_OUT_PHRASES: RegExp[] = [
  /\bplease stop\b/i,
  /\bstop text(ing)?\b/i,
  /\bstop messag(e|ing)\b/i,
  /\b(don'?t|do not) text me\b/i,
  /\bno more text(s)?\b/i,
  /\btake me off (your|the) list\b/i,
  /\bremove me from (your|the) list\b/i,
  /\bquit text(ing)?\b/i,
];

// Deliberately broad / high-recall. False positives just mean a human looks at
// it — that's cheap. False negatives mean the bot improvises on something it
// shouldn't. Bias toward escalating.
const ESCALATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(attorney|lawyer|lawsuit|sue|suing|bbb|better business bureau|regulator|complain\w*)\b/i, reason: "legal/regulatory mention" },
  { pattern: /\b(refunds?|overcharg\w*|billing error|wrong charge|disput\w*)\b/i, reason: "billing dispute" },
  { pattern: /\b(real person|human|talk to someone|speak to someone)\b/i, reason: "explicit request for a human" },
  // Root-caused live 2026-08-03 (Carter Bodily): a bare "manager"/"supervisor"
  // match caught "check with the property manager" — the lead's OWN
  // apartment complex contact, not a request to escalate to one of ours.
  // Requires an actual "talk/speak to/with" request immediately before the
  // word, so it still catches "can I talk to a manager" (see safety.test.ts)
  // without firing on every unrelated mention of "manager."
  { pattern: /\b(talk|speak)\s+(to|with)\s+(a|the|your)?\s*(manager|supervisor)\b/i, reason: "explicit request for a human" },
  { pattern: /\b(spill\w*|leak\w*|injur\w*|hurt|hazard\w*|fire|gas leak|emergency)\b/i, reason: "safety/property-damage report" },
  { pattern: /\b(suicide|self.?harm|kill myself|overdose)\b/i, reason: "possible crisis situation" },
  { pattern: /\b(wrong number|who is this|do i know you)\b/i, reason: "possible wrong number" },
  { pattern: /\b(credit card|debit card|card number|cvv|ssn|social security)\b/i, reason: "payment/PII detail sent over SMS" },
  { pattern: /\b(missed pickup|didn't pick up|didnt pick up|wasn't picked up|wasnt picked up|late pickup)\b/i, reason: "existing-customer service issue" },
  { pattern: /\bcancel (my )?(service|account|subscription|contract)\b/i, reason: "service cancellation request" },
];

// Used by mts-sync/sendRollOffTexts.ts to gate every scheduled text.
// Deliberately NOT used for reactive replies (see evaluateInbound
// below) — per Thomas's call 2026-07-29: if someone texts us, they're
// already awake and engaged, so holding a reply in an ongoing conversation
// they started serves no one.
// Window CONFIRMED BY THOMAS 2026-08-07: 8am-10pm local time — no drip send
// before 8am or at/after 10pm.
export function isWithinQuietHours(now: Date, timezone: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(now)
  );
  return hour >= 8 && hour < 22;
}

export function evaluateInbound(messageBody: string): SafetyVerdict {
  const text = messageBody.trim().toLowerCase().replace(/[.!?]+$/, "");

  if (OPT_OUT_EXACT_KEYWORDS.includes(text)) {
    return { action: "opt_out", reason: "opt-out keyword" };
  }

  if (OPT_OUT_PHRASES.some((p) => p.test(messageBody))) {
    return { action: "opt_out", reason: "opt-out phrase" };
  }

  for (const { pattern, reason } of ESCALATION_PATTERNS) {
    if (pattern.test(messageBody)) {
      return { action: "escalate", reason };
    }
  }

  return { action: "send", reason: "no triggers matched" };
}
