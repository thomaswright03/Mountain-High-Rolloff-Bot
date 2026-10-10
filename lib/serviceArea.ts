// Carried over from the Kaizen lead-responder repo (lib/signupDecision.ts).

function normalizeCity(s: string): string {
  return s.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Is the contact's own on-file city one this brand has stopped signing up
 * (CompanyConfig.excludedCities)? Whole-name, case/punctuation-insensitive
 * match — "LOVELAND" and "Loveland." both match "Loveland", but a
 * different city that merely contains the word doesn't. A missing city is
 * never treated as excluded here; readiness already requires a full
 * address on file before anything gets submitted. */
export function isExcludedCity(serviceCity: string | null | undefined, excludedCities: string[] = []): boolean {
  if (!serviceCity || excludedCities.length === 0) return false;
  const normalized = normalizeCity(serviceCity);
  return excludedCities.some((c) => normalizeCity(c) === normalized);
}
