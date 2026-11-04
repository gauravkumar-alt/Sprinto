/**
 * Publish the current results to Supabase for the public read-only site (and save a local copy in data/).
 * Run: npm run snapshot
 */
import fs from "node:fs";
import path from "node:path";
import { buildSnapshot, publishSnapshot } from "../src/lib/showroom-publish";

async function main() {
  const snap = buildSnapshot();
  const local = path.join(process.cwd(), "data/showroom-snapshot.json"); // data/ is git-ignored
  fs.writeFileSync(local, JSON.stringify(snap));
  console.log(`Local copy: data/showroom-snapshot.json (${(fs.statSync(local).size / 1024).toFixed(0)} KB, emails masked)`);
  console.log(await publishSnapshot());
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
