// Fast, targeted "what is this phone number's current status in MTS right
// now" check — a single leads/list search, not a full export. Needed as a
// mandatory pre-submission gate: confirmed live 2026-07-29 that a majority
// of GHL contacts the AI has "confirmed" a signup with were ALSO
// independently closed by a real human rep through MTS's normal process
// (calling to verify payment after any online signup) in the same window.
// Submitting a real contract for someone already Sold/Existing Customer
// elsewhere would create a duplicate — this check is what prevents that.
//
// Reuses export.js's confirmed-working trick for driving the
// bootstrap-multiselect Status widget (Playwright's selectOption() doesn't
// reliably drive it — confirmed 2026-07-27).
const ALL_STATUS_VALUES = ["1", "2", "9", "10", "11", "12", "6", "3", "7", "4", "8"];

function normalizePhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** @param {import('playwright').Page} page - already logged in via loginToMts
 * @param {string} phone - any format, will be normalized to 10 digits
 * @returns {Promise<string[]>} every Status value found for this phone
 * number, across ALL companies (matching convert.js's own cross-company
 * existing-customer check) — empty array if the phone has no MTS record at all.
 */
export async function checkMtsLeadStatuses(page, phone) {
  const digits = normalizePhone(phone);

  await page.goto("https://kaizen.maxtrackingsolutions.com/leads/list", { waitUntil: "networkidle" });
  await page.evaluate((allValues) => {
    const statusSelect = document.getElementById("SearchCriteria_LeadStatusIds");
    for (const opt of statusSelect.options) opt.selected = allValues.includes(opt.value);
    statusSelect.dispatchEvent(new Event("change", { bubbles: true }));

    const companySelect = document.getElementById("SearchCriteria_CompanyId");
    companySelect.value = ""; // all companies
    companySelect.dispatchEvent(new Event("change", { bubbles: true }));
  }, ALL_STATUS_VALUES);

  await page.fill("#SearchCriteria_SearchText", digits);
  await Promise.all([
    page.waitForLoadState("networkidle"),
    page.getByRole("button", { name: "Search" }).click(),
  ]);

  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes("There is no data available.")) return [];

  const rows = await page.locator("table tbody tr").all();
  const statuses = [];
  for (const row of rows) {
    const cells = await row.locator("td").allInnerTexts();
    // Column order confirmed in mts-poller/src/worker.js's parseLeadRow:
    // Date, Company, Sales Medium, Source, Name, Phone, Email, Address,
    // Serviceable, Status, Note, actions.
    if (cells.length >= 10) statuses.push(cells[9].trim());
  }
  return statuses;
}

/** Root-caused live 2026-08-27 (real client complaint, Mountain High
 * office staff flagged "duplicate accounts"): checkMtsLeadStatuses above
 * only ever looks at MTS's Lead status field, but a real signup that comes
 * in via certain paths (confirmed live: a "Website Signup" contract for
 * Darla Beinarauskas) never flips the matching Lead record's status away
 * from "New" — MTS's Leads and Contracts/Accounts data aren't reliably
 * linked. A phone-only Lead-status check can therefore say "still just a
 * lead" for someone who already has a real, active MTS contract. This
 * checks the actual source of truth instead: /contract/list, the same page
 * office staff manually cross-reference by "ACCT#" (Cust #) to catch this
 * exact problem today.
 *
 * @param {import('playwright').Page} page - already logged in via loginToMts
 * @param {string} phone - any format, will be normalized to 10 digits
 * @returns {Promise<Array<{custNumber: string, name: string, medium: string, status: string, saleDate: string}>>}
 * every contract found for this phone number, across all companies — empty
 * array if none exist. Callers should treat any entry with status "Active"
 * as "this person is already a real customer."
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
