// Shared MTS login flow — extracted from export.js so submitContracts.ts
// doesn't duplicate these selectors and drift out of sync with it.
const EMAIL_XPATH = "xpath=/html/body/div[2]/div[2]/form/div[1]/div/input";
const PASSWORD_XPATH = "xpath=/html/body/div[2]/div[2]/form/div[2]/div/input";

export async function loginToMts(page) {
  const email = process.env.MTS_EMAIL;
  const password = process.env.MTS_PASSWORD;
  if (!email || !password) {
    throw new Error("MTS_EMAIL / MTS_PASSWORD not set — check mts-sync/.env.local");
  }

  await page.goto("https://kaizen.maxtrackingsolutions.com", { waitUntil: "networkidle" });
  await page.locator(EMAIL_XPATH).fill(email);
  await page.locator(PASSWORD_XPATH).fill(password);
  await Promise.all([page.waitForLoadState("networkidle"), page.locator(PASSWORD_XPATH).press("Enter")]);
}
