import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const LIVE = process.argv.includes("--live");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT = LIVE ? 240_000 : 60_000;

// [url, expect the count to drop]
const CASES: [string, boolean][] = [
  ["https://www.w3.org/WAI/demos/bad/before/home.html", true],
  ["https://dequeuniversity.com/demo/mars/", true],
  ["https://www.w3.org/WAI/demos/bad/after/home.html", false],
];

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
await page.goto(BASE + (LIVE ? "/" : "/?mock=1"));

for (const [url, shouldDrop] of CASES) {
  console.log(url);
  await page.fill("#url", url);
  await page.click("#analyze");
  await page.waitForFunction(
    () => {
      const s = document.getElementById("status")!;
      return s.className === "error" || /apply them|No fixes/.test(s.textContent ?? "");
    },
    null,
    { timeout: TIMEOUT },
  );
  const status = await page.textContent("#status");
  check(!(await page.locator("#status.error").count()), `stage 1 finished without error (${status})`);
  check(await page.locator("#afterFig").isHidden(), "After pane is hidden before Fix");
  check((await page.textContent("#tally")) === "", "tally is reset");
  const before = Number(await page.textContent("#count"));
  const patches = await page.locator("#patches li").count();
  console.log(`  before=${before} patches=${patches}`);
  if (await page.locator("#fix").isHidden()) {
    check(!shouldDrop, "no fixes proposed");
    continue;
  }

  await page.click("#fix");
  await page.waitForFunction(() => (document.getElementById("status")!.textContent ?? "").startsWith("Done"), null, {
    timeout: TIMEOUT,
  });
  const after = Number(await page.textContent("#count .after"));
  const tally = await page.textContent("#tally");
  console.log(`  ${before} -> ${after} | ${tally}`);
  check(/^\d+ applied, \d+ skipped$/.test(tally ?? ""), "tally is shown");
  check(shouldDrop ? after < before : after <= before, shouldDrop ? "count dropped" : "count did not rise");
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
