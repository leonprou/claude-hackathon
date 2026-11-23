# WCAG Fixer Demo Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Get the already-built two-stage WCAG Fixer (Analyze → fix list, Fix → live fixed page) committed, proven against the real Claude engine, and rehearsed before the 19:15 freeze.

**Architecture:** One Bun process (`server.ts`) serves `public/index.html` and two endpoints: `GET /api/page` (fetch + sanitise HTML) and `POST /api/fix` (Oren's `fixPage()` from `src/engine.ts`, or a mock). The browser page runs axe-core inside `srcdoc` iframes, lists the patches, applies them to a second iframe and re-audits.

**Tech Stack:** Bun 1.4, TypeScript, vanilla JS page, axe-core 4.14, `@anthropic-ai/sdk` (via `src/engine.ts`), playwright-core driving the installed Google Chrome for the end-to-end check.

**State at the time of writing (18:35):** `server.ts` and `public/index.html` exist untracked in the main checkout and pass a manual headless run against the mock (W3C bad page 44 → 0, Mars 23 → 4). The real engine has never been called from the server: there is no `ANTHROPIC_API_KEY` on this machine.

**Deadlines:** integrate 19:00, freeze 19:15, register 19:20. Tasks 1–3 need no key. Task 4 is blocked until a key is in `.env`; if it is not there by 19:00, skip to Task 5 and demo on Oren's machine or in mock mode.

---

### Task 1: Move the work onto a branch and commit it

**Files:**
- Move: `server.ts`, `public/index.html` (untracked in the main checkout) into a new worktree

**Step 1: Create the worktree**

Run from `/Users/leonid/hackathon`:

```bash
wt switch --create feat/web-app
wt list
```

Expected: `wt list` shows a second worktree for `feat/web-app`. Note its path; every later command runs there. Call it `$WT`.

**Step 2: Move the untracked files in**

```bash
mv /Users/leonid/hackathon/server.ts "$WT/server.ts"
mv /Users/leonid/hackathon/public "$WT/public"
cd "$WT" && bun install
```

Expected: `git status -sb` in `$WT` shows `?? public/` and `?? server.ts`; the main checkout is clean.

**Step 3: Typecheck**

Run: `bunx tsc --noEmit -p .`
Expected: no output.

**Step 4: Commit**

```bash
git add server.ts public/index.html
git commit -m "feat: add Bun server and two-stage fixer page

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 2: Repeatable end-to-end check

A script that drives the real page in headless Chrome, so the rehearsal check is one command. It forces mock mode with `?mock=1`, so it gives the same result whether or not a key is present.

**Files:**
- Create: `scripts/e2e.ts`
- Modify: `package.json` (add `playwright-core` to `devDependencies`, add `"e2e"` script)

**Step 1: Add the dependency and script entry**

```bash
bun add -d playwright-core
```

Then add to `"scripts"` in `package.json`:

```json
"e2e": "bun scripts/e2e.ts"
```

**Step 2: Write the check**

Create `scripts/e2e.ts`:

```ts
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
      return s.className === "error" || /press Fix|No fixes/.test(s.textContent ?? "");
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
```

**Step 3: Run it with the server down, to see it fail**

Run: `lsof -ti :3000 | xargs kill; bun run e2e`
Expected: FAIL with `net::ERR_CONNECTION_REFUSED`.

**Step 4: Run it with the server up**

```bash
bun run server.ts &
sleep 1 && bun run e2e
```

Expected: `all checks passed`, with `44 -> 0` for the first URL and `23 -> 4` for the second (exact counts may shift by one or two with rendering).

**Step 5: Commit**

```bash
git add scripts/e2e.ts package.json bun.lock
git commit -m "test: add headless end-to-end check for both stages

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 3: Elapsed-seconds counter on the loading state

The Claude call may take 10–60 s. A static spinner looks hung on a shared screen.

**Files:**
- Modify: `public/index.html` (the `setStatus` function in the `<script>` block)

**Step 1: Replace `setStatus`**

Replace the whole existing `function setStatus(...) { ... }` with:

```js
let statusTimer;

function setStatus(text, { busy = false, error = false } = {}) {
  clearInterval(statusTimer);
  const el = $("status");
  el.className = error ? "error" : "";
  el.replaceChildren();
  if (!busy) {
    el.append(text);
    return;
  }
  const spinner = Object.assign(document.createElement("span"), { className: "spinner" });
  const elapsed = document.createElement("span");
  elapsed.setAttribute("aria-hidden", "true"); // keep the live region from announcing every second
  const started = Date.now();
  statusTimer = setInterval(() => {
    elapsed.textContent = `${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
  el.append(spinner, text, elapsed);
}
```

**Step 2: Verify by hand**

Open http://localhost:3000/?mock=1, press Analyze. Expected: no counter flashes on the fast steps; reload with the mock delay raised (`Bun.sleep(900)` → `Bun.sleep(5000)` in `server.ts`, temporarily) and confirm "Claude is reading the page… 1s, 2s…" counts up and stops when the list appears. Restore `900`.

**Step 3: Run the end-to-end check**

Run: `bun run e2e`
Expected: `all checks passed`.

**Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: show elapsed seconds while waiting for fixes

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 4: First live run against the real engine (needs the API key)

**Blocked until:** `.env` in `$WT` contains `ANTHROPIC_API_KEY=...` (get it from Oren; `.env` is git-ignored, never commit it).

**Files:**
- Modify only if the run exposes a defect: `public/index.html`, `server.ts`. Do not edit `src/engine.ts`; report engine problems to Oren.

**Step 1: Restart on the engine**

```bash
lsof -ti :3000 | xargs kill; bun run server.ts &
```

Expected log line: `http://localhost:3000  (fixes from: engine)`. If it says `mock`, the key is not being read.

**Step 2: Time the engine alone**

Run: `bun scripts/try-engine.ts`
Expected: a `fix: N patches in X.Xs` line and `RESULT: 42 -> <small number>`. Write down X; it is the wait the audience will sit through.

**Step 3: Run the page end to end**

Run: `bun run e2e --live`
Expected: `all checks passed`. Record before → after and applied/skipped for each URL.

**Step 4: Look at it**

Open http://localhost:3000, run the main URL, press the Fix button, and check by eye:

| Check | If it fails |
|---|---|
| The After page still looks like the Before page | A `setAttr style` or `addCss` patch broke layout: note the patch, tell Oren |
| Skipped count is a small minority | Selectors Claude wrote itself are missing: note three examples for Oren's prompt |
| The list reads well (real alt text, sensible reasons) | Prompt issue: Oren |
| Wait is under ~60 s and the counter keeps ticking | If the request dies near 10 s or 255 s, it is a timeout: check `idleTimeout` in `server.ts` |
| An error from Claude shows as a red message, and Analyze works again afterwards | Fix in `public/index.html` |

**Step 5: Fix page or server defects, one commit each**

For each defect that is ours: reproduce it, fix it, re-run `bun run e2e --live`, commit with a `fix:` message. Use @superpowers:systematic-debugging if a cause is not obvious within two minutes. Stop fixing at 19:15.

---

### Task 5: Open the PR

**Step 1: Sync with Oren's latest**

```bash
git fetch origin && git rebase origin/main
```

If Oren has pushed his own `server.ts` or `public/index.html`, stop and ask Leon which one wins; do not resolve that by guesswork.

**Step 2: Final check, then push**

```bash
bunx tsc --noEmit -p . && bun run e2e
git push -u origin feat/web-app
```

Expected: no typecheck output, `all checks passed`.

**Step 3: Open the PR**

`gh auth switch --user leonprou` first (the repo is on the personal account). Title: `feat: Bun server and two-stage fixer page`. The body must contain:

- What it adds: `server.ts` (page fetch, fix source selection, local axe), `public/index.html` (Analyze → list → Fix → before/after).
- `## Example`: input `https://www.w3.org/WAI/demos/bad/before/home.html`; before this PR the repo had no server or page; after, Analyze lists the patches and the Fix button shows N → M with the applied/skipped tally (use the real numbers from Task 4, or say they are mock numbers). One deliberate non-match: a patch whose selector matches nothing is marked "skipped" and does not stop the run.
- The handoff contract (`/Users/leonid/Downloads/HANDOFF-leon.md`) inlined in a collapsed `<details>` block with a four-backtick fence.
- Last line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

Do not merge; Leon decides.

---

### Task 6: Rehearsal (19:15)

No code. Run once, in order, on the machine that will share its screen:

1. `bun run server.ts`, confirm `fixes from: engine`.
2. Main URL → Analyze → read two fixes aloud → Fix → point at N → M → hover two fixes.
3. Backup URL `https://dequeuniversity.com/demo/mars/` once, to know its numbers.
4. Final shot: `https://www.w3.org/WAI/demos/bad/after/home.html` (W3C's own fixed page) for comparison.
5. Fallback if the API fails live: open `http://localhost:3000/?mock=1` and say it is canned.
