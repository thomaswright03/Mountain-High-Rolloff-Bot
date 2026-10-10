// Creates a roll-off contract and prints its signing link. For trying the
// signing page by hand while the bot is in test mode, e.g.:
//
//   npm run contract:create -- --yards=20 --name="Thomas Test" \
//     --phone=+15555550100 --address="12 Elm St, Greeley, CO 80631" --date=2026-10-20
//
// Needs BLOB_READ_WRITE_TOKEN, CONTRACT_SIGNING_SECRET and PUBLIC_BASE_URL
// (the deployed site, e.g. https://mountain-high-rolloff-bot.vercel.app) in
// .env.local. Contracts made outside production go under test-contracts/.
import { findCompany } from "../lib/companies.js";
import { buildContract, contractLink } from "../lib/contract.js";
import { saveContract } from "../lib/contractStore.js";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const dotenv = await import("dotenv");
  dotenv.default.config({ path: new URL("../.env.local", import.meta.url).pathname });
  const secret = process.env.CONTRACT_SIGNING_SECRET;
  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!secret || !baseUrl || !process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Set BLOB_READ_WRITE_TOKEN, CONTRACT_SIGNING_SECRET and PUBLIC_BASE_URL in .env.local");
  }
  const [yards, name, phone, address] = [arg("yards"), arg("name"), arg("phone"), arg("address")];
  if (!yards || !name || !phone || !address) throw new Error("Need --yards, --name, --phone and --address");

  const contract = buildContract({
    company: findCompany("Mountain High Disposal")!,
    customer: { name, phone, email: arg("email"), serviceAddress: address },
    yards: Number(yards),
    requestedDeliveryDate: arg("date"),
    contactId: arg("contact-id"),
  });
  await saveContract(contract);
  console.log(`Contract ${contract.id}${contract.isTest ? " (test contract)" : ""}:\n${contractLink(baseUrl, contract.id, secret)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
