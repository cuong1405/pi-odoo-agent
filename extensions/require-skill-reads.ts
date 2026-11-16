/**
 * require-skill-reads: make the agent actually READ the Odoo skill guidelines.
 *
 * Why: Pi only advertises a skill's name and description; the model must open the files
 * itself and often does not (and `SKILL.md` is only an index, the rules live in
 * `guidelines/*.md`). Prose in AGENTS.md cannot force that, so this extension does.
 *
 * Nothing about individual guideline files is hard-coded and the extension never matches a
 * row to the edited file: deciding what applies is the agent's job, because many rows depend
 * on what the code does or on the task, not on the file. The extension runs the decision as
 * a walk through the skill's own index table (parsed from its SKILL.md at the moment of the
 * edit, so updating the skill updates the gate). The only fixed facts are which skill covers
 * which kind of location (static/src and static/tests -> odoo-web-guidelines, other addon
 * code -> odoo-guidelines).
 *
 * Flow, per skill, once per session and again after a context compaction:
 *  1. An `edit` / `write` of an addon code file is blocked. The block message gives the file
 *     path, the intended change (the edit's replacement texts, or the start of the written
 *     content) and ROW 1 of the index: title, "Read it when", guideline file.
 *  2. The agent answers with the `guideline_row` tool, one call per row (`apply: true` when
 *     the row's "Read it when" matches the edit or the task at hand, else `false`). Each
 *     result shows the next row. Applying rows are put in a queue.
 *  3. After the last row the tool result lists the queue. The agent must read every queued
 *     guideline file (any tool: `read`, or bash `cat`/`head`/`sed`...). An empty queue is
 *     refused and the walk restarts: some row always applies to addon code.
 *  4. Repeating the edit passes once every queued file has been read. Until then the block
 *     message lists the files still unread.
 * SKILL.md itself never has to be read. If the index table cannot be parsed, the fallback is
 * "read at least one guideline file".
 *
 * Forgets everything on `session_compact` and `session_start`. There is no retry cap and no
 * escape (a human stops a stuck session); the only fail-open is a skill without a SKILL.md
 * or guidelines folder on disk. Files that are not code (docs, translations, images, fonts,
 * json data) are never gated.
 *
 * Install: copy to ~/.pi/agent/extensions/require-skill-reads.ts and run /reload.
 * Override the skills directory with PI_SKILLS_DIR (default ~/.pi/agent/skills).
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKILLS_DIR = path.resolve(
  process.env.PI_SKILLS_DIR || path.join(os.homedir(), ".pi", "agent", "skills"),
);

/** The only fixed facts: which skill covers which location. */
const CODE_SKILL = "odoo-guidelines";
const WEB_SKILL = "odoo-web-guidelines";

function expand(p: string, cwd: string): string {
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

/** True when the file belongs to an addon (nearest manifest, or an `addons` path segment). */
function isAddonFile(abs: string): boolean {
  if (abs.startsWith(SKILLS_DIR + path.sep)) return false;
  if (path.basename(abs) === "__manifest__.py") return true;
  if (abs.split(path.sep).includes("addons")) return true;
  let dir = path.dirname(abs);
  for (let i = 0; i < 8 && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "__manifest__.py"))) return true;
  }
  return false;
}

/**
 * Path segments of the file relative to its addon (nearest ancestor with a __manifest__.py,
 * else the part after the last `addons` segment minus the addon name). Parent directories
 * outside the addon, such as `~/data/` or `~/static/`, must never match a row token.
 */
function addonSegments(abs: string): string[] {
  let dir = path.dirname(abs);
  for (let i = 0; i < 12 && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "__manifest__.py"))) {
      return path.relative(dir, abs).split(path.sep);
    }
  }
  const segs = abs.split(path.sep);
  const idx = segs.lastIndexOf("addons");
  if (idx >= 0 && idx + 2 < segs.length) return segs.slice(idx + 2);
  return [path.basename(abs)];
}

const NOT_CODE = new Set([
  ".md", ".po", ".pot", ".json", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".webp", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".pdf", ".zip",
]);

/** Which skill governs this file, or undefined when it is not covered code. */
function skillFor(rel: string[], abs: string): string | undefined {
  if (NOT_CODE.has(path.extname(abs).toLowerCase())) return undefined;
  if (rel[0] === "static") {
    return ["src", "tests"].includes(rel[1] ?? "") ? WEB_SKILL : undefined;
  }
  return CODE_SKILL;
}

interface IndexRow {
  title: string;
  file: string; // absolute path of the guideline file
  rel: string; // as written in the index, without the anchor
  when: string; // the "Read it when" cell
}

/** Parse the `| [Title](guidelines/x.md#anchor) | read it when ... |` table of a SKILL.md. */
function parseIndex(skill: string): IndexRow[] {
  let text: string;
  try {
    text = readFileSync(path.join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
  } catch {
    return [];
  }
  const rows: IndexRow[] = [];
  const re = /^\|\s*\[([^\]]+)\]\(([^)#\s]+)(?:#[^)]*)?\)\s*\|\s*(.+?)\s*\|\s*$/gm;
  for (const m of text.matchAll(re)) {
    const file = path.resolve(SKILLS_DIR, skill, m[2]);
    if (file.startsWith(SKILLS_DIR + path.sep) && existsSync(file)) {
      rows.push({ title: m[1], file, rel: m[2], when: m[3] });
    }
  }
  return rows;
}

/**
 * Models often read skill files with `cat`/`head`/`sed` in bash instead of the read tool.
 * Count a skill .md file as read when a reader command names it (a listing or grep is not).
 */
const READER_COMMAND = /\b(cat|head|tail|sed|less|more|bat|nl)\b/;
function skillFilesReadBy(command: string, cwd: string): string[] {
  if (!READER_COMMAND.test(command)) return [];
  const found: string[] = [];
  for (const m of command.matchAll(/(?:~|\$\{?HOME\}?|\/)[^\s'"|;&<>()`]*\.md/g)) {
    const abs = expand(m[0].replace(/^\$\{?HOME\}?/, "~"), cwd);
    if (abs.startsWith(SKILLS_DIR + path.sep) && existsSync(abs)) found.push(abs);
  }
  return found;
}

function inputPath(input: Record<string, unknown>): string | undefined {
  const raw = input.path ?? input.file_path ?? input.filePath;
  return typeof raw === "string" && raw ? raw : undefined;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more characters)` : text;

/** The intended change, as far as the tool input shows it (empty when it shows nothing). */
function intendedChange(toolName: string, input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (toolName === "write") {
    const content = str(input.content);
    return content ? `Writes the whole file, starting with:\n${clip(content, 2000)}` : "";
  }
  const items: unknown[] = Array.isArray(input.edits) ? input.edits : [input];
  const parts: string[] = [];
  for (const item of items.slice(0, 5)) {
    const e = (item ?? {}) as Record<string, unknown>;
    const from = str(e.oldText) ?? str(e.oldString);
    const to = str(e.newText) ?? str(e.newString);
    if (to === undefined) continue;
    parts.push(
      (from ? `Replaces:\n${clip(from, 400)}\nwith:\n` : `Inserts:\n`) + clip(to, 800),
    );
  }
  if (items.length > 5) parts.push(`... (+${items.length - 5} more edits)`);
  return parts.join("\n\n");
}

interface Walk {
  rows: IndexRow[];
  cursor: number;
  queue: Set<string>;
  done: boolean;
}

const rowText = (walk: Walk) => {
  const row = walk.rows[walk.cursor];
  return (
    `Row ${walk.cursor + 1}/${walk.rows.length}: ${row.title}\n` +
    `  Read it when: ${row.when}\n` +
    `  Guideline file: ${row.file}`
  );
};

const HOW_TO_ANSWER =
  `Answer with the guideline_row tool, one call per row and one row at a time: ` +
  `apply=true when the row's "Read it when" matches this edit or the task you are working ` +
  `on, apply=false otherwise. Do not answer ahead; each result shows the next row.`;

export default function (pi: ExtensionAPI) {
  const loaded = new Set<string>(); // absolute paths of skill files read this session
  const walks = new Map<string, Walk>(); // skill -> its walk through the index
  let active: string | undefined; // the skill whose row the agent is answering

  const reset = () => {
    loaded.clear();
    walks.clear();
    active = undefined;
  };
  pi.on("session_start", reset);
  pi.on("session_compact", reset);

  pi.registerTool({
    name: "guideline_row",
    label: "Guideline row",
    description:
      "Answer the current row of an Odoo guideline index that a blocked edit asked you to " +
      "walk through. apply=true if the row's 'Read it when' matches your edit or the task " +
      "you are working on, false otherwise. Only usable after an edit was blocked and showed " +
      "you a row.",
    parameters: Type.Object({
      apply: Type.Boolean({
        description: "true when this row applies to the edit or the task, false when it does not.",
      }),
    }),
    async execute(_toolCallId, params) {
      const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
      const walk = active ? walks.get(active) : undefined;
      if (!walk || walk.done) {
        return reply(
          "No guideline index is being walked. Repeat your blocked edit; its block message " +
            "shows the first row.",
        );
      }
      if (params.apply) walk.queue.add(walk.rows[walk.cursor].file);
      walk.cursor++;
      if (walk.cursor < walk.rows.length) {
        return reply(`Recorded. Queued so far: ${walk.queue.size} file(s).\n\n${rowText(walk)}`);
      }
      if (walk.queue.size === 0) {
        walk.cursor = 0;
        return reply(
          `Nothing queued, which cannot be right for an edit of addon code (some row always ` +
            `applies). Walk the index again, reading each "Read it when" against your edit ` +
            `and the task.\n\n${rowText(walk)}`,
        );
      }
      walk.done = true;
      return reply(
        `Index complete. Read every guideline file in your queue now (any tool), then repeat ` +
          `your edit:\n${[...walk.queue].map((f) => `- ${f}`).join("\n")}`,
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    // Record reads when the call STARTS (not when it finishes): sibling calls of one
    // assistant message are checked in order before any of them runs, so a read and an
    // edit sent together would otherwise block the edit. Only existing files count.
    if (event.toolName === "read") {
      const raw = inputPath(event.input as Record<string, unknown>);
      if (raw) {
        const abs = expand(raw, ctx.cwd);
        if (abs.startsWith(SKILLS_DIR + path.sep) && existsSync(abs)) loaded.add(abs);
      }
      return undefined;
    }
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      for (const abs of skillFilesReadBy(command, ctx.cwd)) loaded.add(abs);
      return undefined;
    }
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

    const raw = inputPath(event.input as Record<string, unknown>);
    if (!raw) return undefined;
    const abs = expand(raw, ctx.cwd);
    if (!isAddonFile(abs)) return undefined;
    const rel = addonSegments(abs);
    const skill = skillFor(rel, abs);
    if (!skill) return undefined;
    const skillMd = path.join(SKILLS_DIR, skill, "SKILL.md");
    if (!existsSync(skillMd)) return undefined; // fail open
    const guidelinesDir = path.join(SKILLS_DIR, skill, "guidelines") + path.sep;
    if (!existsSync(guidelinesDir)) return undefined; // fail open

    const rows = parseIndex(skill);
    const change = intendedChange(event.toolName, event.input as Record<string, unknown>);
    const intro =
      `Blocked: read the Odoo guidelines before editing ${abs}.\n` +
      (change ? `\nIntended change:\n${change}\n` : "");

    if (rows.length === 0) {
      if ([...loaded].some((f) => f.startsWith(guidelinesDir))) return undefined;
      return {
        block: true,
        reason:
          `${intro}\nRead at least one guideline file in ${guidelinesDir} that covers your ` +
          `change (any tool), then repeat the edit.`,
      };
    }

    let walk = walks.get(skill);
    if (!walk) {
      walk = { rows, cursor: 0, queue: new Set(), done: false };
      walks.set(skill, walk);
    }
    active = skill;

    if (!walk.done) {
      return {
        block: true,
        reason:
          `${intro}\nWalk the ${skill} guideline index (${rows.length} rows, from its ` +
          `SKILL.md) before this edit. ${HOW_TO_ANSWER}\n\n${rowText(walk)}`,
      };
    }
    const unread = [...walk.queue].filter((f) => !loaded.has(f));
    if (unread.length === 0) return undefined;
    return {
      block: true,
      reason:
        `${intro}\nYou queued these guideline files for this edit; read each one (any tool), ` +
        `then repeat the edit:\n${unread.map((f) => `- ${f}`).join("\n")}`,
    };
  });
}
