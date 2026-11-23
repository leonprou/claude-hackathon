import Anthropic from "@anthropic-ai/sdk";

export type PatchOp = "setAttr" | "setText" | "addCss";

export interface Patch {
  selector: string;
  op: PatchOp;
  name: string;
  value: string;
  wcag: string;
  why: string;
}

export interface FixResult {
  summary: string;
  patches: Patch[];
}

export interface AxeNode {
  target: string[];
  html: string;
  failureSummary?: string;
}

export interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: AxeNode[];
}

export interface FixInput {
  url: string;
  html: string;
  violations: AxeViolation[];
}

export const MODEL = "claude-fable-5-2";

export const PROMPT = `You are fixing a web page so it meets WCAG 2.1 level AA.

You get the page HTML and the violations axe-core found. Return patches that a browser applies to the live DOM.

1. Fix every axe violation. Reuse the axe target selector exactly.
2. Then fix what axe can't judge: alt text that doesn't describe what the image shows, vague link text such as "click here", missing form labels.
3. Write real content. Alt text says what the image shows on this page; link text says where the link goes. Decorative images get alt="".

Ops: setAttr (set attribute "name" to "value"), setText (replace the element's text with "value"), addCss (append CSS "value" to the page; selector ""). Use name "" when the op is not setAttr.
Give each patch its WCAG success criterion number and a one-line reason a non-expert understands.`;

const PATCH_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    patches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          selector: { type: "string" },
          op: { type: "string", enum: ["setAttr", "setText", "addCss"] },
          name: { type: "string" },
          value: { type: "string" },
          wcag: { type: "string" },
          why: { type: "string" },
        },
        required: ["selector", "op", "name", "value", "wcag", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "patches"],
  additionalProperties: false,
} as const;

export function compactHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "<style></style>")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "<svg></svg>")
    .replace(/\s{2,}/g, " ");
}

function compactViolations(violations: AxeViolation[]) {
  return violations.map((v) => ({
    id: v.id,
    help: v.help,
    nodes: v.nodes.map((n) => ({ target: n.target, html: n.html.slice(0, 300) })),
  }));
}

export async function fixPage(
  input: FixInput,
  opts: { client?: Anthropic; effort?: "low" | "medium" | "high" } = {},
): Promise<FixResult> {
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const client =
    opts.client ?? new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    ...(process.env.FIX_FAST === "0" ? {} : { speed: "fast" }),
    fallbacks: "default",
    system: PROMPT,
    output_config: {
      effort: opts.effort ?? "medium",
      format: { type: "json_schema", schema: PATCH_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `URL: ${input.url}\n\nAXE VIOLATIONS:\n${JSON.stringify(compactViolations(input.violations))}\n\nHTML:\n${compactHtml(input.html)}`,
      },
    ],
  } as any);

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined: ${(response as any).stop_details?.category ?? "unknown"}`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude ran out of output tokens before finishing the patch list");
  }
  const text = response.content.find((b: any) => b.type === "text") as any;
  if (!text) throw new Error("Claude returned no text");
  return JSON.parse(text.text) as FixResult;
}

export const MOCK_RESULT: FixResult = {
  summary: "Mock response: set the page language, added alt text, named a link, added link contrast.",
  patches: [
    { selector: "html", op: "setAttr", name: "lang", value: "en", wcag: "3.1.1", why: "Screen readers need the page language to pronounce text correctly" },
    { selector: "img", op: "setAttr", name: "alt", value: "Mock alt text", wcag: "1.1.1", why: "Images need a text alternative" },
    { selector: "a", op: "setAttr", name: "aria-label", value: "Mock link name", wcag: "2.4.4", why: "Links need a name that says where they go" },
    { selector: "", op: "addCss", name: "", value: "a { color: #0645ad; }", wcag: "1.4.3", why: "Link text needs at least 4.5:1 contrast" },
  ],
};
