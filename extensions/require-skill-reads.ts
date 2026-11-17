/**
 * require-skill-reads: make the Odoo skill guidelines actually shape every addon edit.
 *
 * Why: Pi only advertises a skill's name and description; the model must open the files
 * itself and often does not. Reading is not enough either: a model that reads a rule after it
 * composed an edit tends to resend the same edit. So the gate has three parts, each verifying
 * something the extension can see instead of trusting the agent: the right rules were put in
 * front of the model, the model checked its attempt against them rule by rule BEFORE writing
 * the edit, and an edit that its own check calls a violation really changed.
 *
 * Nothing about individual guideline files is hard-coded and the extension never matches a
 * row to the edited file: deciding what applies is the agent's job, because many rows depend
 * on what the code does, not on the file. The only fixed facts are which skill covers which
 * location (static/src and static/tests -> odoo-web-guidelines, other addon code ->
 * odoo-guidelines) and that a skill's SKILL.md holds a table of
 * `| [Title](guidelines/x.md#anchor) | Read it when ... |` rows. The table is parsed from the
 * SKILL.md on disk (at the start of every run and again when a walk starts), so updating the
 * skill updates the gate. The agent never opens SKILL.md. Rows have ids that are unique in
 * the session: `G1..Gn` for odoo-guidelines, `W1..Wn` for odoo-web-guidelines.
 *
 * Flow per BATCH (all the edits and writes of one assistant message), two model rounds:
 *  1. SELECT. The index (id, title, "Read it when") is part of the system prompt (a
 *     `<odoo_guideline_index>` section added in `before_agent_start`, so it is cached and the
 *     model knows the process before its first edit). Before editing, the agent sends one
 *     `guideline_row { row, apply, why }` call per row of the skill its files belong to, all
 *     in the same message (parallel calls, like several `edit` calls). `apply: true` when the
 *     row's "Read it when" matches the edit or the task, else `false`. The result of an
 *     applying row is that row's SECTION of the guideline file (its heading up to the next
 *     heading of the same or higher level, what the SKILL.md anchor points to; the skill says
 *     to read the sections that match, and sections keep the context small), read right then.
 *     Rejected: an unknown row, an empty `why`. A repeated row replaces its earlier answer. A
 *     skill whose rows are all answered with none applying is discarded (some row always
 *     applies to addon code).
 *  2. CHECK + EDIT. The next message holds ONE `guideline_check { checks }` call FIRST and
 *     the edit/write calls after it (calls are checked in the order sent, so the edit sees
 *     the check, and the model writes the edit after, and conditioned on, its own compliance
 *     analysis). Each check names a row, the file the edit touches, ONE rule copied verbatim
 *     from that row's section (the extension verifies the quote is in the section it
 *     delivered), whether the edit complies, and the evidence. Every accepted row and every
 *     file of the batch needs at least one check. The edit passes when the check covers its
 *     file and, where the check reports a violation (`complies: false`, which requires a `fix`:
 *     the corrected code as it will appear in the edit), the edit's new text contains each fix
 *     and differs from a blocked attempt (otherwise it is blocked and the violated rules are
 *     repeated). With no violation the attempt may be resent unchanged.
 * Fallback, when the agent edits without having walked the index: the edit is blocked and the
 * unanswered rows of the file's skill appear in the model's transcript as one injected
 * `guideline_row` call + result per row (the `context` hook rewrites what the model sees; the
 * session itself is untouched), so the walk takes one more round. A batch that touches both
 * skills needs the rows of both. The walk expires 3 turns after it started if no edit used it,
 * and every later batch needs a new one: an earlier read may have covered another section.
 * If a skill's table cannot be parsed, the fallback is "read at least one guideline file of
 * the skill" and no check.
 *
 * Verified: the quoted rules exist in the delivered sections, every accepted row and file is
 * covered, a reported violation changed the edit. Not verifiable: that a claimed
 * `complies: true` is true. The end-of-task odoo-review gate is the backstop for that.
 *
 * Forgets the walk on `session_compact` and `session_start`. There is no retry cap and no
 * escape (a human stops a stuck session); the only fail-open is a skill without a SKILL.md or
 * guidelines folder on disk. Files that are not code (docs, translations, images, fonts, json
 * data) are never gated.
 *
 * Install: copy to ~/.pi/agent/extensions/require-skill-reads.ts and run /reload.
 * Override the skills directory with PI_SKILLS_DIR (default ~/.pi/agent/skills).
 */

import { createHash } from "node:crypto";
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
  anchor: string; // the heading slug after '#', or ""
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
  const re = /^\|\s*\[([^\]]+)\]\(([^)#\s]+)(?:#([^)\s]*))?\)\s*\|\s*(.+?)\s*\|\s*$/gm;
  for (const m of text.matchAll(re)) {
    const file = path.resolve(SKILLS_DIR, skill, m[2]);
    if (file.startsWith(SKILLS_DIR + path.sep) && existsSync(file)) {
      rows.push({ title: m[1], file, rel: m[2], anchor: m[3] ?? "", when: m[4] });
    }
  }
  return rows;
}

const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

/**
 * The section a SKILL.md anchor points to: its heading up to the next heading of the same or
 * higher level (code fences are skipped, so `# good` comments in examples are not headings).
 * Falls back to the whole file when the anchor matches no heading.
 */
function sectionOf(row: IndexRow): string {
  let text: string;
  try {
    text = readFileSync(row.file, "utf8");
  } catch {
    return "";
  }
  if (!row.anchor) return text;
  const lines = text.split("\n");
  let fence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start < 0) {
      if (slug(m[2]) === row.anchor) {
        start = i;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join("\n").trimEnd();
    }
  }
  return start < 0 ? text : lines.slice(start).join("\n").trimEnd();
}

/** Lower-case, no markdown emphasis or quotes, single spaces: how quotes are compared. */
const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[`*_"'\u2018\u2019\u201c\u201d]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The text an edit/write puts into the file (replacement texts, or the written content). */
function newTextOf(toolName: string, input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (toolName === "write") return str(input.content);
  const items: unknown[] = Array.isArray(input.edits) ? input.edits : [input];
  return items
    .map((item) => {
      const e = (item ?? {}) as Record<string, unknown>;
      return str(e.newText) || str(e.newString);
    })
    .join("\n");
}

const inputHash = (input: unknown) =>
  createHash("sha1").update(JSON.stringify(input)).digest("hex");

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

interface CheckEntry {
  row: string;
  path: string;
  rule: string;
  complies: boolean;
  evidence: string;
  fix?: string; // when complies is false: the corrected text the edit must contain
}

interface RowRef {
  id: string; // G3, W2: unique in the session
  skill: string;
  n: number; // position in its skill's index, from 1
  total: number; // rows in its skill's index
  row: IndexRow;
}

interface Batch {
  rows: Map<string, RowRef>;
  bySkill: Map<string, RowRef[]>;
  answers: Map<string, { apply: boolean; why: string }>;
  sections: Map<string, string>; // delivered section of every applying row
  checks?: CheckEntry[]; // the latest valid guideline_check
  attempts: Map<string, Set<string>>; // file -> hashes of the inputs this batch blocked
  shownTurn: Map<string, number>; // skill -> turn in which its rows were injected
  openedTurn: number;
  openedSeq: number;
  grantUntil: number; // -1 until an edit passed; the batch is reusable while turn <= this
}

const SKILL_PREFIX: Record<string, string> = { [CODE_SKILL]: "G", [WEB_SKILL]: "W" };
const MAX_WALK_AGE = 3; // turns an unused walk stays valid

const rowIntro = (r: RowRef) =>
  `Row ${r.id} (${r.n}/${r.total}): ${r.row.title}\n` +
  `Read it when: ${r.row.when}\n` +
  `Guideline file: ${r.row.file}\n\n` +
  `Decide this row: call guideline_row { row: "${r.id}", apply: true|false, why: "<a few words>" }.`;

/** Rows shown to the model as injected tool calls, anchored to the blocked call they follow. */
interface Shown {
  anchorId: string;
  calls: { id: string; row: string; text: string }[];
}

const FRESH =
  `Every edit or write of addon code needs a fresh walk of the guideline index and a fresh ` +
  `read of the guideline sections that apply, even if you read them before: an earlier read ` +
  `may have covered another section. All the edits and writes you send in one message ` +
  `share one walk.`;

const HOW_TO_SELECT =
  `Decide every row of the skill with its own guideline_row call, all sent in one message ` +
  `(the way you send several edit calls at once): { row: "<id>", apply, why }. apply=true ` +
  `when the row's "Read it when" matches this edit or the task you are working on, ` +
  `apply=false otherwise; why says what matched, or why the row does not apply. The result ` +
  `of an applying row is its guideline section, read right then. At least one row applies ` +
  `to any edit of addon code.`;

const HOW_TO_CHECK =
  `Check your attempt against the rules you just read. Send ONE guideline_check call ` +
  `FIRST and your edit/write calls AFTER it, all in the same message (calls are checked in ` +
  `the order sent). guideline_check { checks: [ { row, path, rule, complies, evidence } ] }: ` +
  `row = the row id; path = the file the edit touches; rule = ONE rule copied verbatim ` +
  `from that row's section, preferably the one your edit is most likely to break (the quote ` +
  `is verified against the section you were given); complies = true or false; evidence = ` +
  `what in the edit satisfies the rule, or what is wrong with it. Give at least one check ` +
  `for every row you accepted and for every file you edit. Write the edit AFTER the check, ` +
  `so it reflects it. Where the attempt breaks a rule, say complies=false and give fix = the ` +
  `corrected code exactly as it will appear in your edit: an edit that does not contain the ` +
  `fix (or that is unchanged from a blocked attempt) is blocked.`;

const PROCESS =
  `Before the first edit or write of addon code in a message, walk the index of the skill ` +
  `the files belong to (odoo-guidelines rows G* for everything outside static/, ` +
  `odoo-web-guidelines rows W* for static/src and static/tests): ${HOW_TO_SELECT} Then, in ` +
  `your NEXT message: ${HOW_TO_CHECK} Every later batch of edits needs a new walk. An edit ` +
  `sent without the walk is blocked.`;

/** All rows of the skills that exist on disk, with their session-wide ids. */
function loadRows(): { rows: Map<string, RowRef>; bySkill: Map<string, RowRef[]> } {
  const rows = new Map<string, RowRef>();
  const bySkill = new Map<string, RowRef[]>();
  for (const skill of [CODE_SKILL, WEB_SKILL]) {
    const parsed = parseIndex(skill);
    const list = parsed.map((row, i) => ({
      id: `${SKILL_PREFIX[skill]}${i + 1}`,
      skill,
      n: i + 1,
      total: parsed.length,
      row,
    }));
    bySkill.set(skill, list);
    for (const r of list) rows.set(r.id, r);
  }
  return { rows, bySkill };
}

function indexSection(): string | undefined {
  const { bySkill } = loadRows();
  const parts: string[] = [];
  for (const [skill, list] of bySkill) {
    if (list.length === 0) continue;
    const scope =
      skill === WEB_SKILL ? "for files under static/src and static/tests" : "for all other addon code";
    parts.push(
      `${skill} (${scope}):\n` + list.map((r) => `${r.id} | ${r.row.title} | ${r.row.when}`).join("\n"),
    );
  }
  if (parts.length === 0) return undefined;
  return `${PROCESS}\n\n${parts.join("\n\n")}`;
}

export default function (pi: ExtensionAPI) {
  let seq = 0;
  let turn = 0;
  const readSeq = new Map<string, number>(); // skill file -> seq of its latest read
  const blockedIds = new Set<string>(); // calls this extension blocked (not tool failures)
  let batch: Batch | undefined;
  let shown: Shown[] = [];

  const reset = () => {
    readSeq.clear();
    blockedIds.clear();
    batch = undefined;
    shown = [];
  };
  pi.on("session_start", reset);
  pi.on("session_compact", reset);
  pi.on("turn_start", async () => {
    turn++;
  });

  pi.on("before_agent_start", async (event) => {
    const section = indexSection();
    const options = (event as { systemPromptOptions?: { sections?: Record<string, string> } })
      .systemPromptOptions;
    if (section && options) {
      options.sections = options.sections ?? {};
      options.sections.odoo_guideline_index = section;
    }
    return undefined;
  });

  /** The walk for the current batch; a stale or used-up one is replaced by a fresh one. */
  const ensureBatch = (): Batch => {
    const stale =
      batch !== undefined &&
      (batch.grantUntil >= 0 ? turn > batch.grantUntil : turn - batch.openedTurn > MAX_WALK_AGE);
    if (!batch || stale) {
      const { rows, bySkill } = loadRows();
      batch = {
        rows,
        bySkill,
        answers: new Map(),
        sections: new Map(),
        attempts: new Map(),
        shownTurn: new Map(),
        openedTurn: turn,
        openedSeq: ++seq,
        grantUntil: -1,
      };
    }
    return batch;
  };

  const accepted = (b: Batch, skill?: string) =>
    [...b.answers]
      .filter(([id, a]) => a.apply && (!skill || b.rows.get(id)?.skill === skill))
      .map(([id]) => id);
  const unanswered = (b: Batch, skill: string) =>
    (b.bySkill.get(skill) ?? []).filter((r) => !b.answers.has(r.id));
  const skillDone = (b: Batch, skill: string) =>
    (b.bySkill.get(skill) ?? []).length > 0 &&
    unanswered(b, skill).length === 0 &&
    accepted(b, skill).length > 0;

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
      "Decide ONE row of an Odoo guideline index (ids like G3, W2 are listed in the " +
      "odoo_guideline_index section of the system prompt). Before editing addon code, call it " +
      "once per row of the skill your files belong to, all in the same message. apply=true if " +
      "the row's 'Read it when' matches your edit or the task you are working on (the result " +
      "is then the guideline section), false otherwise; why in a few words. Without apply it " +
      "only shows the row.",
    promptSnippet: "Decide one row of an Odoo guideline index (walk it before editing addon code)",
    promptGuidelines: [
      "Use guideline_row once per index row, all in one message, before an edit or write of addon code; an applying row returns its guideline section.",
      "Use guideline_check before the edit or write of addon code, in the same message and ahead of it, after guideline_row returned the sections; write the edit after the check.",
    ],
    parameters: Type.Object({
      row: Type.String({ description: 'The row id from the index, such as "G3" or "W2".' }),
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
      const b = ensureBatch();
      const id = params.row.trim().toUpperCase();
      const ref = b.rows.get(id);
      if (!ref) {
        return reply(
          `Row ${params.row} does not exist. Row ids are ${[...b.rows.keys()].join(", ") || "(no index found)"}. Not recorded.`,
        );
      }
      if (params.apply === undefined) return reply(rowIntro(ref));
      const why = (params.why ?? "").trim();
      if (why.length < 3) return reply(`Row ${id} needs a "why" (a few words). Not recorded.`);
      b.answers.set(id, { apply: params.apply, why });
      let head = `Row ${id} (${ref.row.title}) does not apply.`;
      let file: string | undefined;
      b.sections.delete(id);
      if (params.apply) {
        const section = sectionOf(ref.row);
        if (section) {
          b.sections.set(id, section);
          readSeq.set(ref.row.file, ++seq);
          file = ref.row.file;
          head = `Row ${id} applies. Guideline section (${ref.row.file}):\n\n${section}\n`;
        } else {
          head = `Row ${id} applies, but ${ref.row.file} could not be read; read it with the read tool.`;
        }
      }
      const missing = unanswered(b, ref.skill);
      const total = ref.total;
      if (missing.length > 0) {
        return reply(
          `${head}\n${ref.skill}: ${total - missing.length}/${total} rows answered; not answered ` +
            `yet: ${missing.map((r) => r.id).join(", ")}.`,
          { file },
        );
      }
      if (accepted(b, ref.skill).length === 0) {
        for (const r of b.bySkill.get(ref.skill) ?? []) b.answers.delete(r.id);
        return reply(
          `All ${total} ${ref.skill} rows answered, but none applies, which cannot be right for ` +
            `an edit of addon code (some row always applies). Nothing was kept: read each "Read ` +
            `it when" against your edit and the task, and decide every row again, all in the ` +
            `same message.`,
        );
      }
      return reply(`${head}\nAll ${total} ${ref.skill} rows answered.\n\n${HOW_TO_CHECK}`, { file });
    },
  });

  pi.registerTool({
    name: "guideline_check",
    label: "Guideline check",
    description:
      "Check your intended edit against the guideline sections you just read, BEFORE the edit " +
      "and in the same message, as the first call. One entry per rule: the row id, the file, " +
      "ONE rule quoted verbatim from that row's section, whether the edit complies, and the " +
      "evidence. At least one entry for every accepted row and every file you edit. Where " +
      "complies=false the edit that follows must change.",
    promptSnippet: "Check an intended addon edit against the guideline sections just read",
    parameters: Type.Object({
      checks: Type.Array(
        Type.Object({
          row: Type.String({ description: 'The row id whose section the rule comes from, such as "G5".' }),
          path: Type.String({ description: "The file the edit or write touches." }),
          rule: Type.String({
            description: "One rule copied verbatim from that row's section; it is verified.",
          }),
          complies: Type.Boolean({ description: "Whether the intended edit follows the rule." }),
          evidence: Type.String({
            description: "What in the edit satisfies the rule, or what is wrong with it.",
          }),
          fix: Type.Optional(
            Type.String({
              description:
                "Required when complies is false: the corrected code, exactly as it will " +
                "appear in your edit (a line or more), so the edit can be verified to contain it.",
            }),
          ),
        }),
        { minItems: 1, maxItems: 40 },
      ),
    }),
    executionMode: "sequential",
    async execute() {
      const violations = batch?.checks?.filter((c) => !c.complies) ?? [];
      const text = !batch?.checks
        ? "No guideline walk needs a check right now."
        : `Check recorded: ${batch.checks.length} rule(s), ${violations.length} violation(s).` +
          (violations.length
            ? ` The edit for ${[...new Set(violations.map((v) => v.path))].join(", ")} must contain ` +
              `the fix you gave for each violated rule.`
            : ` Send your edit now (in this message, after this call).`);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  /** Rows of every finished skill that still have no check entry. */
  const uncoveredRows = (b: Batch, entries: CheckEntry[]) =>
    accepted(b).filter((id) => {
      const skill = b.rows.get(id)!.skill;
      return skillDone(b, skill) && !entries.some((c) => c.row === id);
    });

  /** Validate a guideline_check input against the walk; the entries when valid. */
  const parseChecks = (b: Batch, input: unknown, cwd: string): { entries?: CheckEntry[]; problems: string[] } => {
    const problems: string[] = [];
    const raw = (input as { checks?: unknown })?.checks;
    if (!Array.isArray(raw) || raw.length === 0) return { problems: ["`checks` is empty."] };
    const entries: CheckEntry[] = [];
    const seen = new Set<string>();
    raw.forEach((e: any, i: number) => {
      const at = `check ${i + 1}`;
      const id = String(e?.row ?? "").trim().toUpperCase();
      const section = b.sections.get(id);
      if (!section) {
        problems.push(`${at}: row ${e?.row} is not a row you accepted (accepted: ${accepted(b).join(", ")}).`);
        return;
      }
      const rule = String(e?.rule ?? "");
      const body = norm(section.split("\n").slice(1).join("\n"));
      if (norm(rule).length < 15 || !body.includes(norm(rule))) {
        problems.push(
          `${at}: the rule is not a verbatim quote (at least 15 characters) from the section of ` +
            `row ${id}; copy a rule exactly from that section.`,
        );
        return;
      }
      if (String(e?.evidence ?? "").trim().length < 10) {
        problems.push(`${at}: evidence must say what in the edit satisfies the rule or what is wrong.`);
        return;
      }
      if (typeof e?.path !== "string" || !e.path) {
        problems.push(`${at}: path is missing.`);
        return;
      }
      const fix = typeof e?.fix === "string" ? e.fix : "";
      if (e?.complies !== true && norm(fix).length < 8) {
        problems.push(
          `${at}: complies is false, so give fix = the corrected code exactly as it will appear ` +
            `in your edit (at least 8 characters).`,
        );
        return;
      }
      const file = expand(e.path, cwd);
      const key = `${id}|${norm(rule)}|${file}`;
      if (seen.has(key)) {
        problems.push(`${at}: the same rule is checked twice for the same file.`);
        return;
      }
      seen.add(key);
      entries.push({
        row: id,
        path: file,
        rule,
        complies: e.complies === true,
        evidence: String(e.evidence).trim(),
        fix: e.complies === true ? undefined : fix,
      });
    });
    if (problems.length) return { problems };
    for (const id of uncoveredRows(b, entries)) problems.push(`no check for accepted row ${id}.`);
    for (const file of b.attempts.keys()) {
      if (!entries.some((c) => c.path === file)) problems.push(`no check for the file ${file}.`);
    }
    return problems.length ? { problems } : { entries, problems };
  };

  pi.on("tool_result", async (event) => {
    if (event.toolName === "guideline_row" && !event.isError) return undefined;
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    if (blockedIds.delete(event.toolCallId)) return undefined; // blocked by us, not failed
    if (!event.isError) return undefined;
    if (batch && batch.grantUntil === turn) batch.grantUntil = turn + 1; // the retry needs no new walk
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

    const block = (reason: string) => {
      blockedIds.add(event.toolCallId);
      return { block: true, reason };
    };

    if (event.toolName === "guideline_check") {
      const b = ensureBatch();
      if (![...b.bySkill.keys()].some((skill) => skillDone(b, skill))) {
        return block(
          "No guideline index is fully answered: answer every row of the skill with " +
            "guideline_row first (all in one message), then send the check. A walk expires " +
            `${MAX_WALK_AGE} turns after it started if no edit used it, so walk it again if ` +
            "you took longer.",
        );
      }
      const parsed = parseChecks(b, event.input, ctx.cwd);
      if (!parsed.entries) {
        return block(
          `guideline_check rejected, nothing recorded:\n` +
            parsed.problems.map((p) => `- ${p}`).join("\n"),
        );
      }
      b.checks = parsed.entries;
      return undefined;
    }

    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

    const raw = inputPath(event.input as Record<string, unknown>);
    if (!raw) return undefined;
    const abs = expand(raw, ctx.cwd);
    if (!isAddonFile(abs)) return undefined;
    const skill = skillFor(addonSegments(abs), abs);
    if (!skill) return undefined;
    if (!existsSync(path.join(SKILLS_DIR, skill, "SKILL.md"))) return undefined; // fail open
    const guidelinesDir = path.join(SKILLS_DIR, skill, "guidelines") + path.sep;
    if (!existsSync(guidelinesDir)) return undefined; // fail open

    const b = ensureBatch();
    const hash = inputHash(event.input);
    const remember = () => {
      const set = b.attempts.get(abs) ?? new Set<string>();
      set.add(hash);
      b.attempts.set(abs, set);
    };
    const change = intendedChange(event.toolName, event.input as Record<string, unknown>);
    const short = `Blocked: ${abs}.` + (change ? `\n\nIntended change:\n${change}\n` : "");

    const skillRows = b.bySkill.get(skill) ?? [];
    if (skillRows.length === 0) {
      const fresh = [...readSeq].some(([f, n]) => f.startsWith(guidelinesDir) && n > b.openedSeq);
      if (!fresh) {
        remember();
        return block(
          `${short}\nRead at least one guideline file in ${guidelinesDir} that covers your ` +
            `change (any tool), then repeat the edit.`,
        );
      }
      b.grantUntil = turn;
      return undefined;
    }

    if (!skillDone(b, skill)) {
      remember();
      const left = unanswered(b, skill);
      const none = accepted(b, skill).length === 0 && left.length === 0;
      if (left.length > 0 && b.shownTurn.get(skill) !== turn) {
        b.shownTurn.set(skill, turn);
        const tag = event.toolCallId.replace(/[^a-zA-Z0-9]/g, "").slice(-24);
        shown.push({
          anchorId: event.toolCallId,
          calls: left.map((r) => ({ id: `glr${tag}x${r.id}`, row: r.id, text: rowIntro(r) })),
        });
      }
      return block(
        `Blocked: read the Odoo guidelines again before editing ${abs}.\n${FRESH}\n` +
          (change ? `\nIntended change:\n${change}\n` : "") +
          `\nWalk the ${skill} guideline index (rows ${skillRows[0].id}-${skillRows[skillRows.length - 1].id}) ` +
          `before this edit. ` +
          (left.length > 0
            ? `The ${left.length} row(s) you have not decided are shown to you as their own guideline_row ` +
              `tool calls and results in this same assistant message. `
            : none
              ? `Your answers had no applying row, so decide every row again. `
              : ``) +
          `${HOW_TO_SELECT}\n\nAfter the rows: ${HOW_TO_CHECK}`,
      );
    }

    if (!b.checks || uncoveredRows(b, b.checks).length > 0) {
      remember();
      return block(
        `${short}\nThe rows are answered (accepted: ${accepted(b).join(", ")}), but ` +
          `${b.checks ? "your guideline_check does not cover all of them" : "no guideline_check came before this edit"}. ` +
          HOW_TO_CHECK,
      );
    }
    const covering = b.checks.filter((c) => c.path === abs);
    if (covering.length === 0) {
      remember();
      b.checks = undefined;
      return block(
        `${short}\nYour guideline_check has no entry for ${abs}. Send it again, now covering ` +
          `every file of this batch, before the edits. ${HOW_TO_CHECK}`,
      );
    }
    const violated = covering.filter((c) => !c.complies);
    const written = norm(newTextOf(event.toolName, event.input as Record<string, unknown>));
    const missingFix = violated.filter((c) => !written.includes(norm(c.fix ?? "")));
    if (missingFix.length > 0) {
      return block(
        `${short}\nYour own guideline_check says this edit breaks:\n` +
          missingFix.map((c) => `- "${c.rule}" (row ${c.row}): ${c.evidence}`).join("\n") +
          `\nbut the edit does not contain the fix you gave for it:\n` +
          missingFix.map((c) => `${c.fix}`).join("\n---\n") +
          `\nChange the edit so that it contains the fix, then send it again; the check stays valid.`,
      );
    }
    if (violated.length > 0 && b.attempts.get(abs)?.has(hash)) {
      return block(
        `${short}\nYour own guideline_check reports a violation for this file, but the edit is the ` +
          `same as the blocked attempt. Change it so that it follows the rule(s), then send it ` +
          `again; the check stays valid.`,
      );
    }
    b.grantUntil = turn;
    return undefined;
  });
}
