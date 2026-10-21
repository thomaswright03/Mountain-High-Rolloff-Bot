import type { CompanyConfig } from "./types.js";

/**
 * Brands this bot texts for. Only Mountain High Disposal rents roll-offs
 * today. matchValue must exactly match the GHL "Company" custom field.
 * The service area, states and excluded cities are kept in step with the
 * Kaizen lead-responder repo's lib/companies.ts (same brand, same area).
 */
const COMPANIES: CompanyConfig[] = [
  {
    matchValue: "Mountain High Disposal",
    repName: "Max",
    displayName: "Mountain High Disposal",
    timezone: "America/Denver",
    serviceAreaNotes: `
      CONFIRMED DIRECTLY BY THE CEO 2026-07-30 (sent a screenshot of the real
      mountainhighdisposal.com signup page's own city list) — this is the
      authoritative service area, resolving the earlier public-site-vs-MTS-
      admin conflict in favor of this list. Cities served: Ault, Aurora,
      Berthoud, Centennial, Cherry Hills Village, Denver, Eaton, Englewood,
      Evans, Fort Collins, Galeton, Gill, Gillcrest, Greeley, Johnstown,
      Kersey, Lakewood, Laporte, LaSalle, Littleton, Lucerne, Milliken,
      Pierce, Severance, Sherrelwood, Timnath, Thornton, Welby, Wellington,
      Westminster, Windsor.
      NO LONGER SIGNING UP LOVELAND (Thomas, 2026-09-29): Loveland used to
      be on this list, but Mountain High no longer takes new signups there.
      If the lead's address is in Loveland, don't start or continue a
      signup (no summary, no asking them to type their name) — tell them
      Mountain High isn't signing up new customers in Loveland right now.
      The MTS admin tax-body list shows a broader/different 46-city list
      (adds Arvada, Boulder, Wheat Ridge, Parker, Golden, Highlands Ranch,
      and more) — do NOT use that one; it does not reflect the CEO-confirmed
      real service area above.
      The lead record itself also carries a Serviceable Yes/No/Possibly field —
      TODO: confirm whether the agent should trust that field directly or
      re-derive it from a city list.
      "Prohibit Sales Outside Areas" is set to No for this brand (looser than
      Eastern Waste's Yes) — TODO: confirm what that should mean for how
      cautious the AI needs to be about serviceability here.
    `.trim(),
    serviceStates: ["CO"],
    // Thomas, 2026-09-29: "don't sign up anyone in loveland anymore".
    excludedCities: ["Loveland"],
    // Thomas, 2026-10-10: a roll-off version of this bot for Mountain High,
    // for people who start the online roll-off booking and don't finish.
    // Every fact below is from mountainhighdisposal.com/rolloff/ and
    // /temp-roll-off--signup/ as of 2026-10-10, except the prices, which
    // are the CEO's (relayed by Thomas, 2026-10-10). Still not approved:
    // the overweight fee, extra days and any delivery fee.
    rollOff: {
      // The booking form itself is MTS's RollOffSignupWidget, embedded on
      // this page — the same MTS system the residential signup uses.
      bookingUrl: "https://mountainhighdisposal.com/temp-roll-off--signup/",
      serviceArea: `
        Mountain High delivers roll-off dumpsters in Colorado only. Cities
        served: Ault, Aurora, Berthoud, Centennial, Cherry Hills Village,
        Denver, Eaton, Englewood, Evans, Fort Collins, Galeton, Gill,
        Gillcrest, Greeley, Johnstown, Kersey, Lakewood, Laporte, LaSalle,
        Littleton, Lucerne, Milliken, Pierce, Severance, Sherrelwood,
        Timnath, Thornton, Welby, Wellington, Westminster, Windsor.
        Mountain High is not taking new customers in Loveland right now. If
        the address is in Loveland, or outside Colorado, or a city not on
        this list, don't promise anything: say the office can check whether
        they can deliver there (970-834-1144).
      `.trim(),
      facts: `
        Sizes (outside dimensions, from the website):
        - 6 yard: 82" long x 72" wide x 61" tall
        - 8 yard: 82" long x 80" wide x 73" tall
        - 20 yard: 16' long x 8' wide x 4'6" tall
        - 30 yard: 18' long x 8' wide x 6' tall
        Rental period: 7 days.
        Not allowed in the dumpster: shingles, paint, rock, dirt, yard waste,
        concrete, oil, or hazardous materials.
        Prices (per dump, each with a weight limit):
        - 6 yard: $275, up to 1 ton
        - 8 yard: $325, up to 1 ton
        - 20 yard: $400, up to 4 tons
        - 30 yard: $450, up to 5 tons
        Over the weight limit (from the contract's own terms): 6 and 8 yard
        are $85 extra for anything over 1 ton; 20 and 30 yard are $50 per
        ton over the limit, and $100 per ton over 10 tons.
        Delivery: within 24-48 hours, not counting weekends. Delivery on a
        specific day is $100 extra. Pickup is on day 7 unless they call the
        office to extend; extra days have a daily fee.
        Filling it past the top (overfilling) is $100.
        Street placement needs a permit before delivery.
        Not approved to quote: the daily rate for extra days, or any other
        fee not listed here. If they ask, say the office can give them the
        exact number.
        Booking: you book it with them right here over text. You ask what
        the contract still needs (size, business or personal, where to put
        it, and whether they want a call before delivery), then they get a
        summary to sign by replying with their full name. You never take a
        card: the office calls to take payment after they sign. The office
        can also book it with them over the phone instead.
        Office phone: 970-834-1144.
      `.trim(),
      voiceGuide: `
        Sound like Max, a real Mountain High rep texting, not a polished
        support bot. Lowercase starts are normal ("yeah I got you").
        Minimal punctuation, no em dashes, no semicolons. Two short plain
        sentences beat one long one. Short warm affirmations are good:
        "sweet," "yeah," "yup," "sounds good." Use ":)" only on a friendly
        close, never on bad news. Use their first name now and then, not in
        every message. Never sound like a support macro: no restating their
        question back, no "I understand your frustration."
      `.trim(),
      contract: {
        sizes: [
          { yards: 6, dimensions: `82" long x 72" wide x 61" tall`, pricePerDump: 275, tonLimit: 1, overweightFee: "$85 extra for anything over 1 ton" },
          { yards: 8, dimensions: `82" long x 80" wide x 73" tall`, pricePerDump: 325, tonLimit: 1, overweightFee: "$85 extra for anything over 1 ton" },
          { yards: 20, dimensions: `16' long x 8' wide x 4'6" tall`, pricePerDump: 400, tonLimit: 4, overweightFee: "$50 per ton over 4 tons, and $100 per ton over 10 tons" },
          { yards: 30, dimensions: `18' long x 8' wide x 6' tall`, pricePerDump: 450, tonLimit: 5, overweightFee: "$50 per ton over 5 tons, and $100 per ton over 10 tons" },
        ],
        rentalDays: 7,
        notAllowed: ["shingles", "paint", "rock", "dirt", "yard waste", "concrete", "oil", "hazardous materials"],
        officePhone: "970-834-1144",
        // From the Agreements on MTS's own roll-off contract summary page
        // (Thomas's screenshot, 2026-10-21).
        specificDayFee: 100,
        overfillFee: 100,
        // TODO: Mountain High's own roll-off rental terms (overweight
        // charges, extra days, damage, placement, cancellation). Until
        // then every contract says it's a test.
        standardTerms: null,
      },
    },
  },
];

export function allCompanies(): readonly CompanyConfig[] {
  return COMPANIES;
}

export function findCompany(matchValue: string | undefined): CompanyConfig | undefined {
  if (!matchValue) return undefined;
  const normalized = matchValue.trim().toLowerCase();
  return COMPANIES.find((c) => c.matchValue.toLowerCase() === normalized);
}
