# a11y-audit: WCAG 2.1 auditor — design

Spec: https://www.w3.org/TR/WCAG21/

## Usage

```
a11y-audit <url|file.html> [--level A|AA|AAA] [--json out.json] [--html report.html]
```

Default level is AA. Exit code 1 when any rule fails, 2 on a run error, 0 otherwise.

## Stack

TypeScript, pnpm, Playwright (Chromium), esbuild, vitest.

## Architecture

- **Node side** (`src/cli.ts`, `src/runner.ts`, `src/report/*`): launches the page, injects the
  bundled rule script, collects results, writes reports.
- **In-page side** (`src/rules/*`, `src/page/*`): one rule per file plus shared helpers
  (visibility, effective background colour, selector, snippet). esbuild bundles these into one
  IIFE that is injected into the page; in-page code never imports Node modules.
- **Accessible names and roles** come from Chromium's accessibility tree, fetched by the runner
  and handed to the in-page rules, not reimplemented.
- **Success-criteria catalog** (`src/wcag/criteria.json`): all 78 criteria (number, title, level,
  principle, guideline, URL), generated from the spec page by `scripts/build-criteria.ts`.

## Result model

Each rule returns findings with an outcome of `fail`, `pass`, `needs-review` or `inapplicable`.
Uncertain cases (text over a background image, for example) are `needs-review`, never `fail`.

```ts
interface Rule {
  id: string;            // "image-alt"
  criteria: string[];    // ["1.1.1"]
  description: string;
  run(ctx: RuleContext): Finding[];
}
interface Finding {
  outcome: "fail" | "pass" | "needs-review" | "inapplicable";
  selector?: string;
  snippet?: string;
  message: string;
}
```

A rule runs only when at least one of its criteria is within the requested level.

## First-wave rules

| Rule | Success criteria |
|---|---|
| image-alt | 1.1.1 |
| form-label | 1.3.1, 3.3.2, 4.1.2 |
| autocomplete-valid | 1.3.5 |
| link-name, button-name | 2.4.4, 4.1.2 |
| page-title | 2.4.2 |
| html-lang | 3.1.1 |
| heading-order | 1.3.1 |
| landmarks | 1.3.1 |
| color-contrast | 1.4.3 |
| non-text-contrast | 1.4.11 |
| duplicate-id | 4.1.1 |
| aria-valid | 4.1.2 |
| tabindex-positive | 2.4.3 |
| viewport-zoom | 1.4.4 |
| target-size | 2.5.5 (AAA) |

## Report

Self-contained HTML grouped by principle, then criterion, with selector and snippet per finding.
Criteria with no automated rule are listed as "needs manual review". The summary says "no
automated violations found", never "conforms". The report must pass its own audit.

## Tests

Each rule has an HTML fixture with at least one failing case and one passing case that looks like
a failure. A catalog test asserts 78 criteria and the per-level split. An end-to-end test audits
the generated report.

## Out of scope

Iframes, closed shadow roots, states that need interaction (hover, modals), multi-page crawling.
