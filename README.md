# Mountain High Roll-off Bot

Texts people who start booking a roll-off dumpster on
mountainhighdisposal.com (MTS's roll-off booking widget) and don't finish,
and answers their replies. It never books anything itself, since a booking
needs a card and an e-signature: it points them back to the booking form
(the link is put in by code, never written by the model) or hands them to
the office for a call.

Split out of the Kaizen lead-responder repo (Mountain High's residential
trash bot) on 2026-10-10. Both bots share the same GHL location and MTS
login; they're kept apart by GHL tags.

## How it works

- **Who it texts:** GHL contacts tagged `ai-rolloff-eligible`.
  `mts-sync/importRollOffLeads.ts` applies the tag. Every 10 minutes it reads
  MTS's Manage Roll-Off Leads page (`/rolloffleads/list`) and picks up Mountain
  High leads that are New or Follow-Up, serviceable, and dated today or
  yesterday. The old backlog is never picked up, and neither is Loveland or
  anyone out of state. The residential bot (Kaizen) skips these contacts.
- **Scheduled texts:** `mts-sync/sendRollOffTexts.ts`, run every 10 minutes by
  `.github/workflows/send-rolloff-texts.yml`. A fixed first text 30+ minutes
  after the lead lands, a nudge the next day, a final nudge 3 days later, then
  nothing. Texts only go out 8am-10pm Denver time, never to Loveland or out of
  state, and never once MTS shows a contract made since they started.
- **Replies:** `api/webhook.ts` (a Vercel function) calls
  `lib/rollOffReply.ts`. Contacts without the roll-off tag are ignored.
  STOP and similar opt out. Card numbers, legal threats, a request for a
  person and the like go straight to the office (tagged `ai-needs-human` and
  starred). Once a rep texts in a thread, the bot stays out of it.
- **Facts the bot may state:** `rollOff` in `lib/companies.ts`: sizes, the
  CEO's per-dump prices and weight limits, the 7-day rental, and what can't
  go in. Anything else (overweight fees, extra days) goes to the office.

## Contract signing page

Thomas, 2026-10-10: a page where a lead reads and e-signs their roll-off
contract, at `/contract/{id}?t={token}` (`api/contract.ts`).

- **The contract** (`lib/contract.ts`) is built by code from the brand's
  config: size, the CEO's per-dump price and weight limit, the 7-day rental,
  what can't go in, the service address and requested delivery date. It
  says that signing doesn't take payment: the office calls to take the card
  and confirm the date. Until Mountain High's own standard terms are added
  (`rollOff.contract.standardTerms` in `lib/companies.ts`), every contract is
  marked as a test, not binding.
- **Download for AI** gives the exact contract as a Markdown file, with a
  short note asking the customer's AI to explain it.
- **Signing** takes a typed name, a drawn signature and an e-sign consent
  box. The signature is only accepted for the exact text shown, and only
  once. The signature record (name, image, time, IP, browser, the
  contract's SHA-256) and a signed copy (contract plus signature plus
  signing record) are stored together in the private Vercel Blob store,
  and the signer can download the signed copy.
- **After signing**, outside DRY_RUN, the GHL contact gets a note and the
  `ai-rolloff-contract-signed` and `ai-needs-human` tags, so the office
  takes it from there.
- **Sent by the bot:** once a lead has picked a size, a reply can text them
  their contract link (`lib/contractLink.ts`). The model only marks where
  the link goes. A separate call reads the size and day they chose, code
  checks the size is one Mountain High rents and the day is within 90 days,
  and the address and phone come from the contact on file. If any of that
  is missing, or signing isn't set up, nothing is sent and the office takes
  it. Signing takes no card (Thomas, 2026-10-10): the office calls after.
- **Trying it by hand:** `npm run contract:create -- --yards=20
  --name="Test Person" --phone=+15555550100
  --address="12 Elm St, Greeley, CO 80631" --date=2026-10-20` prints a
  signing link.

## Before it goes live

1. **Test mode for now (Thomas, 2026-10-10).** The workflow runs with
   `DRY_RUN: "true"`: it only logs what it would pick up and send, and writes
   nothing to GHL.
2. `ROLLOFF_TCPA_CONSENT_CONFIRMED` in `mts-sync/sendRollOffTexts.ts` stays
   `false` until Mountain High's CEO OKs texting these leads.
3. The first test-mode runs should be checked against the real MTS page:
   the lead pick-up was built from a screenshot, not the page's HTML.

## Setup

1. `npm ci`, copy `.env.example` to `.env.local` and fill it in.
2. Deploy to Vercel (`vercel deploy --prod`) and set the same variables
   there. Connect a Blob store (Storage tab) for contracts and signatures.
3. In GHL, add a workflow: trigger **Customer Replied** (SMS), filtered to
   contacts with the `ai-rolloff-eligible` tag, action **Webhook** POST to
   `https://<vercel-domain>/api/webhook?secret=<WEBHOOK_SHARED_SECRET>` with
   contact ID, conversation ID, location ID, phone and message in the body.
4. Add the GitHub Actions secrets the workflow reads: `ANTHROPIC_API_KEY`,
   `MTS_EMAIL`, `MTS_PASSWORD`, `GHL_API_TOKEN`, `GHL_LOCATION_ID`,
   `GHL_COMPANY_FIELD_KEY`, `KILLSWITCH_URL`.

## Checks

```
npm run typecheck
npm test
```

Tests mock GHL and Claude, so they need no keys.
