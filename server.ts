// Web app + backend in one Bun process. POST /api/fix picks its source in this order:
//   ?mock=1             -> a mock derived from the posted violations
//   ANTHROPIC_API_KEY   -> fixPage() from src/engine.ts (Bun reads .env)
//   FIX_API_URL         -> forwarded to a remote fix API
//   none of the above   -> the mock

import { fixPage, type FixInput } from "./src/engine";

const PORT = Number(process.env.PORT ?? 3000);
const FIX_API_URL = process.env.FIX_API_URL;
const FIX_SOURCE = process.env.ANTHROPIC_API_KEY ? "engine" : FIX_API_URL ? "remote" : "mock";

type AxeNode = { target: string[]; html: string; failureSummary?: string };
type Violation = { id: string; impact?: string; help: string; nodes: AxeNode[] };
type Patch = {
  selector: string;
  op: "setAttr" | "setText" | "addCss";
  name?: string;
  value: string;
  wcag: string;
  why: string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function getPage(target: string | null): Promise<Response> {
  let url: URL;
  try {
    url = new URL(target ?? "");
  } catch {
    return json({ error: "Enter a full URL, including https://" }, 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return json({ error: "Only http and https URLs are supported" }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (a11y-fixer)", accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return json({ error: `Could not fetch the page: ${(err as Error).message}` }, 502);
  }
  if (!upstream.ok) {
    return json({ error: `The site answered ${upstream.status}` }, 502);
  }

  const finalUrl = upstream.url || url.href;
  const base = `<base href="${Bun.escapeHTML(finalUrl)}">`;
  let sawHead = false;
  const rewriter = new HTMLRewriter()
    .on("script", { element: (el) => void el.remove() })
    .on("base", { element: (el) => void el.remove() })
    .on("meta", {
      element(el) {
        const equiv = el.getAttribute("http-equiv")?.toLowerCase();
        if (equiv === "content-security-policy" || equiv === "refresh") el.remove();
      },
    })
    .on("head", {
      element(el) {
        sawHead = true;
        el.prepend(base, { html: true });
      },
    });

  let html = rewriter.transform(await upstream.text());
  if (!sawHead) html = base + html;
  return json({ url: finalUrl, html });
}

const MOCK_RULES: Record<string, (node: AxeNode) => Omit<Patch, "selector">> = {
  "html-has-lang": () => ({
    op: "setAttr", name: "lang", value: "en", wcag: "3.1.1",
    why: "Screen readers need the page language to pronounce text correctly",
  }),
  "image-alt": () => ({
    op: "setAttr", name: "alt", value: "Described image (mock)", wcag: "1.1.1",
    why: "Image had no text alternative",
  }),
  "link-name": () => ({
    op: "setAttr", name: "aria-label", value: "Link destination (mock)", wcag: "2.4.4",
    why: "Link had no accessible name",
  }),
  "select-name": () => ({
    op: "setAttr", name: "aria-label", value: "Choose an option (mock)", wcag: "4.1.2",
    why: "Select had no label",
  }),
  label: () => ({
    op: "setAttr", name: "aria-label", value: "Input field (mock)", wcag: "4.1.2",
    why: "Form field had no label",
  }),
  "button-name": () => ({
    op: "setAttr", name: "aria-label", value: "Button (mock)", wcag: "4.1.2",
    why: "Button had no accessible name",
  }),
  "color-contrast": () => ({
    op: "setAttr", name: "style", value: "color:#000;background:#fff", wcag: "1.4.3",
    why: "Text contrast was below 4.5:1",
  }),
};

async function mockFix(violations: Violation[]): Promise<Response> {
  const patches: Patch[] = [];
  for (const v of violations) {
    const rule = MOCK_RULES[v.id];
    if (!rule) continue;
    for (const node of v.nodes) {
      const selector = node.target?.[0];
      if (typeof selector === "string") patches.push({ selector, ...rule(node) });
    }
  }
  patches.push({
    selector: "", op: "addCss", value: "a:focus-visible { outline: 3px solid #1a5fb4; outline-offset: 2px; }",
    wcag: "2.4.7", why: "Keyboard focus was not visible on links",
  });
  patches.push({
    selector: "#element-that-does-not-exist", op: "setText", value: "Read more",
    wcag: "2.4.4", why: "Mock patch with a selector that matches nothing",
  });
  await Bun.sleep(900);
  return json({ summary: `Mock response: ${patches.length} patches derived from the axe results.`, patches });
}

async function fix(req: Request, mock: boolean): Promise<Response> {
  let body: { url?: string; html?: string; violations?: Violation[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  if (mock || FIX_SOURCE === "mock") return mockFix(body.violations ?? []);

  if (FIX_SOURCE === "engine") {
    try {
      return json(await fixPage({ url: body.url ?? "", html: body.html ?? "", violations: body.violations ?? [] } as FixInput));
    } catch (err) {
      console.error(err);
      return json({ error: `Claude call failed: ${(err as Error).message}` }, 502);
    }
  }

  try {
    const upstream = await fetch(FIX_API_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    return json({ error: `Fix API unreachable: ${(err as Error).message}` }, 502);
  }
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // the fix call can take a minute; Bun's default is 10 s
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/page" && req.method === "GET") {
      return getPage(url.searchParams.get("url"));
    }
    if (url.pathname === "/api/fix" && req.method === "POST") {
      return fix(req, url.searchParams.get("mock") === "1");
    }
    if (url.pathname === "/axe.min.js") {
      return new Response(Bun.file(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir)), {
        headers: { "content-type": "application/javascript" },
      });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(new URL("./public/index.html", import.meta.url)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return json({ error: "Not found" }, 404);
  },
});

console.log(`http://localhost:${server.port}  (fixes from: ${FIX_SOURCE})`);
