// Audits the fixer's own UI with axe-core in three states: initial, analyzed, fixed.
// Usage: bun scripts/self-audit.ts [--shots <dir>]   (server must be running; uses mock fixes)

import { chromium, type Page } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TARGET = process.env.TARGET_URL ?? `${BASE}/demo/bakery.html`;
const shotsAt = process.argv.indexOf("--shots");
const SHOTS = shotsAt === -1 ? null : process.argv[shotsAt + 1];
const AXE = await Bun.file(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir)).text();

let failed = 0;

async function audit(page: Page, name: string) {
  // Let entrance animations finish so contrast is measured on the settled page.
  await page.waitForTimeout(1600);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const result = await page.evaluate(async (source) => {
    if (!("axe" in window)) (0, eval)(source);
    const axe = (window as any).axe;
    const r = await axe.run(
      { exclude: [["iframe"]] },
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } },
    );
    const brief = (list: any[]) =>
      list.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.map((n: any) => n.target.join(" ")) }));
    return { violations: brief(r.violations), incomplete: brief(r.incomplete) };
  }, AXE);
  console.log(`${name}: ${result.violations.length} violations, ${result.incomplete.length} need review`);
  for (const v of result.violations) console.log(`  FAIL   ${v.id}: ${v.help}\n         ${v.nodes.join("\n         ")}`);
  for (const v of result.incomplete) console.log(`  review ${v.id}: ${v.help}\n         ${v.nodes.join("\n         ")}`);
  failed += result.violations.length;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("pageerror", (e) => {
  console.log(`  page error: ${e.message}`);
  failed++;
});

await page.goto(`${BASE}/?mock=1`);
await audit(page, "1-initial");

await page.fill("#url", TARGET);
await page.click("#analyze");
await page.waitForFunction(() => /press Fix|No fixes/.test(document.getElementById("status")!.textContent ?? ""));
await audit(page, "2-analyzed");

await page.click("#fix");
await page.waitForFunction(() => (document.getElementById("status")!.textContent ?? "").startsWith("Done"));
await audit(page, "3-fixed");

await browser.close();
if (failed) {
  console.error(`\n${failed} problem(s) in the fixer's own UI`);
  process.exit(1);
}
console.log("\nthe fixer passes its own audit");
