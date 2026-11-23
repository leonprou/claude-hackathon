import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fixPage, MOCK_RESULT, type FixResult, type Patch } from "../src/engine";

const url = process.argv.find((a) => a.startsWith("http")) ?? "https://www.w3.org/WAI/demos/bad/before/home.html";
const mock = process.argv.includes("--mock");
const effort = (process.argv.find((a) => a.startsWith("--effort="))?.split("=")[1] ?? "medium") as "low" | "medium" | "high";
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

async function audit(html: string) {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  dom.window.eval(axeSource);
  const r = await (dom.window as any).axe.run(dom.window.document, {
    runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
    rules: { "color-contrast": { enabled: false } },
  });
  return { dom, violations: r.violations, count: r.violations.reduce((n: number, v: any) => n + v.nodes.length, 0) };
}

function apply(doc: Document, patches: Patch[]) {
  let applied = 0, skipped = 0;
  for (const p of patches) {
    try {
      if (p.op === "addCss") {
        doc.head.insertAdjacentHTML("beforeend", `<style>${p.value}</style>`);
        applied++;
        continue;
      }
      const els = doc.querySelectorAll(p.selector);
      if (!els.length) { skipped++; continue; }
      els.forEach((el) => (p.op === "setAttr" ? el.setAttribute(p.name, p.value) : (el.textContent = p.value)));
      applied++;
    } catch {
      skipped++;
    }
  }
  return { applied, skipped };
}

const html = (await (await fetch(url)).text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
const before = await audit(html);
console.log(`before: ${before.count} failing elements in ${before.violations.length} rules (${before.violations.map((v: any) => v.id).join(", ")})`);

const t0 = Date.now();
const result: FixResult = mock ? MOCK_RESULT : await fixPage({ url, html, violations: before.violations }, { effort });
console.log(`fix: ${result.patches.length} patches in ${((Date.now() - t0) / 1000).toFixed(1)}s (effort=${effort}${mock ? ", mock" : ""})`);
console.log(`summary: ${result.summary}`);

const { applied, skipped } = apply(before.dom.window.document, result.patches);
const out = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1];
if (out) await Bun.write(out, before.dom.serialize());
const after = await audit(before.dom.serialize());
console.log(`applied ${applied}, skipped ${skipped}`);
console.log(`after: ${after.count} failing elements (${after.violations.map((v: any) => v.id).join(", ") || "none"})`);
console.log(`RESULT: ${before.count} -> ${after.count}`);
for (const p of result.patches.slice(0, 8)) console.log(`  [${p.wcag}] ${p.op} ${p.selector} ${p.name} = ${p.value.slice(0, 60)}  // ${p.why}`);
