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

export const PROMPT = `Make this page pass WCAG 2.1 AA with the smallest change. It must still look like the same site.

1. Fix every axe violation, using the axe selector.
2. Fix what axe misses: vague link text, missing labels, alt text that doesn't say what the image shows.
3. One addCss patch for visual failures. Check every text color against its background yourself. Keep every font, layout, background and hue. Shift each failing color darker or lighter in the same hue until it reaches 4.5:1. Make all text at least 14px with line-height 1.5. Add a focus outline, 44px controls, and a symbol where only color carries meaning. Use !important.

Ops: setAttr (name, value), setText (value), addCss (value; selector ""). name is "" unless setAttr.
Each patch: WCAG criterion and a one-line reason.`;

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
