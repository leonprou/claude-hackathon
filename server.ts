// Web app + backend in one Bun process. POST /api/fix returns MOCK_RESULT for ?mock=1,
// otherwise fixPage() from src/engine.ts (Bun reads ANTHROPIC_API_KEY from .env).

import { resolve, sep } from "node:path";
import { fixPage, MOCK_RESULT, type FixInput } from "./src/engine";

const PUBLIC_DIR = resolve(import.meta.dir, "public");
const PORT =Number(process.env.PORT ?? 3000);

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

async function fix(req: Request, mock: boolean): Promise<Response> {
  if (mock) return json(MOCK_RESULT);
  try {
    const { url, html, violations } = (await req.json()) as FixInput;
    return json(await fixPage({ url, html, violations }));
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message }, 500);
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
    if (req.method === "GET") {
      // Static files under public/; the prefix check rejects paths that escape it.
      const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1);
      const filePath = resolve(PUBLIC_DIR, relative);
      const file = Bun.file(filePath);
      if (filePath.startsWith(PUBLIC_DIR + sep) && (await file.exists())) return new Response(file);
    }
    return json({ error: "Not found" }, 404);
  },
});

console.log(`http://localhost:${server.port}`);
