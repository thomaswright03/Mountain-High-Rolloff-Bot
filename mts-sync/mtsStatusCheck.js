// "Does this phone number already have an MTS contract?" Checked before
// every roll-off text, so someone who finished booking (online or with the
// office) never gets "still need one?" (mts-sync/sendRollOffTexts.ts).

function normalizePhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** Contracts, not leads, are the source of truth (live, 2026-08-27): an MTS
 * Lead record's status isn't reliably updated when a signup becomes a
 * contract, so this reads /contract/list, the page the office itself
 * cross-references by Cust #.
 *
 * @param {import('playwright').Page} page - already logged in via loginToMts
 * @param {string} phone - any format, will be normalized to 10 digits
 * @returns {Promise<Array<{custNumber: string, name: string, medium: string, status: string, saleDate: string}>>}
 * every contract found for this phone number, across all companies — empty
 * array if none exist.
 */
export async function checkMtsContractList(page, phone) {
  const digits = normalizePhone(phone);

  await page.goto("https://kaizen.maxtrackingsolutions.com/contract/list", { waitUntil: "networkidle" });
  await page.fill("#SearchCriteria_SearchText", digits);
  await Promise.all([
    page.waitForLoadState("networkidle"),
    page.getByRole("button", { name: "Search" }).click(),
  ]);

  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes("There is no data available.")) return [];

  const rows = await page.locator("table tbody tr").all();
  const contracts = [];
  for (const row of rows) {
    // Column order confirmed live 2026-08-27 against the real page:
    // Reviewed, Sale Date, Cust #, Name, Address, Start Date, Company,
    // Medium, Sales Rep, Status, Integration, Map Pin.
    const cells = await row.locator("td").allInnerTexts();
    if (cells.length >= 10) {
      contracts.push({
        // Raw cell text — mts-sync/sendRollOffTexts.ts parses it (see
        // lib/rollOff.ts's parseMtsDate) to tell a contract made since a
        // roll-off lead started booking from an older one.
        saleDate: cells[1].trim(),
        custNumber: cells[2].trim(),
        name: cells[3].trim(),
        medium: cells[7].trim(),
        status: cells[9].trim(),
      });
    }
  }
  return contracts;
}
