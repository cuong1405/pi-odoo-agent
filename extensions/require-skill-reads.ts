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
 * Flow, for EVERY `edit` / `write` of an addon code file (all the edits and writes of one
 * assistant message count as one batch and share one walk):
 *  1. The edit is blocked. The block message gives the file path and the intended change (the
 *     edit's replacement texts, or the start of the written content).
 *  2. The index rows are NOT put in that message. The extension rewrites the transcript the
 *     model sees (the `context` hook) so the blocked assistant message also contains one
 *     `guideline_row { row }` tool call per index row, each with its own tool result: the
 *     row's title, "Read it when" and guideline file. The model receives N separate calls and
 *     N separate results.
 *  3. The agent decides every row with its own real `guideline_row { row, apply, why }` call,
 *     all sent in the same message (parallel tool calls, the way several `edit` calls are
 *     sent). `apply: true` when the row's "Read it when" matches the edit or the task at
 *     hand, else `false`; `why` says in a few words what matched or why not. An accepted row
 *     is read in that same call: its result is the guideline file, freshly. Each result also
 *     says how many rows are answered and which are not yet. A row that does not exist or has
 *     an empty `why` is not recorded; a repeated row replaces its earlier answer; an answer
 *     set where no row applies is discarded and must be given again (some row always applies
 *     to addon code).
 *  4. Repeating the edit passes once every row is answered, and so does every other
 *     edit/write of the same assistant message. The next turn's edit or write starts a new
 *     walk. (If an edit that passed fails, say because its old text was not found, the retry
 *     in the next turn passes without a new walk.)
 * The walk is per skill, so a batch touching both code and `static/` needs both walks.
 * SKILL.md itself never has to be read. If the index table cannot be parsed, the fallback is
 * "read at least one guideline file".
 *
 * Forgets all walks on `session_compact` and `session_start`. There is no retry cap and no
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
  answers: Map<number, { apply: boolean; why: string }>;
  doneSeq: number; // 0 until every row is answered
  grantUntil: number; // -1 until an edit passed; edits of turns <= this need no new walk
  shownTurn: number; // turn in which the rows were last put in front of the model
}

const rowText = (walk: Walk, k: number) => {
  const row = walk.rows[k - 1];
  return (
    `Row ${k}/${walk.rows.length}: ${row.title}\n` +
    `Read it when: ${row.when}\n` +
    `Guideline file: ${row.file}\n\n` +
    `Decide this row: call guideline_row { row: ${k}, apply: true|false, why: "<a few words>" }.`
  );
};

/** Rows shown to the model as injected tool calls, anchored to the blocked call they follow. */
interface Shown {
  anchorId: string;
  calls: { id: string; row: number; text: string }[];
}

const FRESH =
  `Every edit or write of addon code needs a fresh walk of the guideline index and a fresh ` +
  `read of the guideline files that apply, even if you read them before: an earlier read ` +
  `may have covered another section. All the edits and writes you send in one message ` +
  `share one walk.`;

const HOW_TO_ANSWER =
  `Each row of the index is shown to you as its own guideline_row tool call and result in ` +
  `this same assistant message. Decide every row with its own guideline_row call, all sent ` +
  `in one message (the way you send several edit calls at once): { row, apply, why }. ` +
  `apply=true when the row's "Read it when" matches this edit or the task you are working ` +
  `on, apply=false otherwise; why says what matched, or why the row does not apply. The ` +
  `result of an applying row is the guideline file itself, read right then. At least one ` +
  `row applies to any edit of addon code. Then repeat your edit.`;

export default function (pi: ExtensionAPI) {
  let seq = 0;
  let turn = 0;
  const readSeq = new Map<string, number>(); // skill file -> seq of its latest read
  const walks = new Map<string, Walk>(); // skill -> its current walk through the index
  const blockedIds = new Set<string>(); // calls this extension blocked (not tool failures)
  let shown: Shown[] = [];
  let active: string | undefined; // the skill whose rows the agent is answering

  const reset = () => {
    readSeq.clear();
    walks.clear();
    blockedIds.clear();
    shown = [];
    active = undefined;
  };
  pi.on("session_start", reset);
  pi.on("session_compact", reset);
  pi.on("turn_start", async () => {
    turn++;
  });

  /**
   * Put one guideline_row call + result per row into the assistant message that was blocked,
   * as the model sees it. The session itself is untouched; the same rewrite is applied before
   * every later request so the model keeps seeing the rows.
   */
  pi.on("context", async (event) => {
    if (shown.length === 0) return undefined;
    const messages = event.messages as any[];
    let changed = false;
    for (const entry of shown) {
      const i = messages.findIndex(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) => c.type === "toolCall" && c.id === entry.anchorId),
      );
      if (i < 0) continue;
      const at = messages[i];
      if (at.content.some((c: any) => c.type === "toolCall" && c.id === entry.calls[0]?.id)) continue;
      let j = i + 1;
      while (j < messages.length && messages[j].role === "toolResult") j++;
      const now = Date.now();
      messages[i] = {
        ...at,
        content: [
          ...at.content,
          ...entry.calls.map((c) => ({
            type: "toolCall",
            id: c.id,
            name: "guideline_row",
            arguments: { row: c.row },
          })),
        ],
      };
      messages.splice(
        j,
        0,
        ...entry.calls.map((c) => ({
          role: "toolResult",
          toolCallId: c.id,
          toolName: "guideline_row",
          content: [{ type: "text", text: c.text }],
          isError: false,
          timestamp: now,
        })),
      );
      changed = true;
    }
    return changed ? { messages } : undefined;
  });

  pi.registerTool({
    name: "guideline_row",
    label: "Guideline row",
    description:
      "Decide ONE row of an Odoo guideline index that a blocked edit showed you. Call it once " +
      "per row, all rows in the same message. apply=true if the row's 'Read it when' matches " +
      "your edit or the task you are working on (the result is then the guideline file), " +
      "false otherwise; why in a few words. Without apply it only shows the row again. Only " +
      "usable after an edit was blocked and showed you the rows.",
    parameters: Type.Object({
      row: Type.Integer({ minimum: 1, description: "The row number shown after the blocked edit." }),
      apply: Type.Optional(
        Type.Boolean({
          description: "true when this row applies to the edit or the task, false when it does not.",
        }),
      ),
      why: Type.Optional(
        Type.String({
          description: "A few words: what in the edit or task matches the row, or why it does not apply.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const reply = (text: string, details: Record<string, unknown> = {}) => ({
        content: [{ type: "text" as const, text }],
        details,
      });
      const walk = active ? walks.get(active) : undefined;
      if (!walk || walk.doneSeq > 0) {
        return reply(
          "No guideline index is being walked. Repeat your blocked edit; the rows are shown " +
            "after it.",
        );
      }
      const n = walk.rows.length;
      if (params.row < 1 || params.row > n) {
        return reply(`Row ${params.row} does not exist (rows are 1-${n}). Not recorded.`);
      }
      if (params.apply === undefined) return reply(rowText(walk, params.row));
      const why = (params.why ?? "").trim();
      if (why.length < 3) {
        return reply(`Row ${params.row} needs a "why" (a few words). Not recorded.`);
      }
      walk.answers.set(params.row, { apply: params.apply, why });
      const missing = walk.rows.map((_, i) => i + 1).filter((r) => !walk.answers.has(r));
      let body = "";
      let file: string | undefined;
      if (params.apply) {
        file = walk.rows[params.row - 1].file;
        try {
          body = readFileSync(file, "utf8");
          readSeq.set(file, ++seq);
        } catch {
          file = undefined;
          body = `(could not read ${walk.rows[params.row - 1].file}; read it with the read tool)`;
        }
      }
      const head =
        `Row ${params.row} ${params.apply ? "applies" : "does not apply"}. ` +
        (params.apply ? `Guideline file ${walk.rows[params.row - 1].file}:\n\n${body}\n\n` : "");
      if (missing.length > 0) {
        return reply(
          `${head}${walk.answers.size}/${n} rows answered; not answered yet: ${missing.join(", ")}.`,
          { file },
        );
      }
      if (![...walk.answers.values()].some((a) => a.apply)) {
        walk.answers.clear();
        return reply(
          `All ${n} rows answered, but none applies, which cannot be right for an edit of ` +
            `addon code (some row always applies). Nothing was kept: read each "Read it when" ` +
            `against your edit and the task, and decide every row again, all in the same ` +
            `message.`,
        );
      }
      walk.doneSeq = ++seq;
      return reply(`${head}All ${n} rows answered. Repeat your edit now.`, { file });
    },
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    if (blockedIds.delete(event.toolCallId)) return undefined; // blocked by us, not failed
    if (!event.isError) return undefined;
    for (const walk of walks.values()) {
      if (walk.grantUntil === turn) walk.grantUntil = turn + 1; // the retry needs no new walk
    }
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    // Record reads when the call STARTS (not when it finishes): sibling calls of one
    // assistant message are checked in order before any of them runs, so a read and an
    // edit sent together would otherwise block the edit. Only existing files count.
    const noteRead = (abs: string) => {
      if (abs.startsWith(SKILLS_DIR + path.sep) && existsSync(abs)) readSeq.set(abs, ++seq);
    };
    if (event.toolName === "read") {
      const raw = inputPath(event.input as Record<string, unknown>);
      if (raw) noteRead(expand(raw, ctx.cwd));
      return undefined;
    }
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      for (const abs of skillFilesReadBy(command, ctx.cwd)) noteRead(abs);
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

    let walk = walks.get(skill);
    if (walk && walk.grantUntil >= 0) {
      if (turn <= walk.grantUntil) return undefined; // same batch (or retry of a failed edit)
      walks.delete(skill); // the grant was used up: this edit needs a new walk
      walk = undefined;
    }
    const rows = parseIndex(skill);
    if (!walk) {
      walk = {
        rows,
        answers: new Map(),
        doneSeq: rows.length === 0 ? ++seq : 0, // no parsable index: any fresh guideline read
        grantUntil: -1,
        shownTurn: -1,
      };
      walks.set(skill, walk);
    }
    active = skill;

    const block = (reason: string) => {
      blockedIds.add(event.toolCallId);
      return { block: true, reason };
    };
    const change = intendedChange(event.toolName, event.input as Record<string, unknown>);
    const intro =
      `Blocked: read the Odoo guidelines again before editing ${abs}.\n${FRESH}\n` +
      (change ? `\nIntended change:\n${change}\n` : "");

    if (walk.doneSeq === 0) {
      if (walk.shownTurn !== turn) {
        walk.shownTurn = turn;
        const tag = event.toolCallId.replace(/[^a-zA-Z0-9]/g, "").slice(-24);
        shown.push({
          anchorId: event.toolCallId,
          calls: walk.rows.map((_, i) => ({
            id: `glr${tag}x${i + 1}`,
            row: i + 1,
            text: rowText(walk!, i + 1),
          })),
        });
      }
      return block(
        `${intro}\nWalk the ${skill} guideline index (${rows.length} rows, from its SKILL.md) ` +
          `before this edit. ${HOW_TO_ANSWER}`,
      );
    }
    if (walk.rows.length === 0) {
      const fresh = [...readSeq].some(([f, n]) => f.startsWith(guidelinesDir) && n > walk.doneSeq);
      if (!fresh) {
        return block(
          `${intro}\nRead at least one guideline file in ${guidelinesDir} that covers your ` +
            `change (any tool), then repeat the edit.`,
        );
      }
    }
    walk.grantUntil = turn;
    return undefined;
  });
}
