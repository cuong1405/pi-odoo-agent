/**
 * require-skill-reads: make the Odoo skill guidelines actually shape every addon edit.
 *
 * Why: Pi only advertises a skill's name and description; the model must open the files
 * itself and often does not. Reading is not enough either: a model that reads a rule after it
 * composed an edit tends to resend the same edit. So the gate verifies what the extension can
 * see instead of trusting the agent: the matching rules were put in front of the model, the
 * model checked its attempt against them rule by rule BEFORE writing the edit, and an edit that
 * its own check calls a violation really changed.
 *
 * Scope: the `edit` tool (one file, one or many replacements; several edit calls in one
 * message are one batch) on addon code. `write` is never gated. Files that are not code (docs,
 * translations, images, fonts, json data) are never gated.
 *
 * Nothing about individual guideline files is hard-coded. The only fixed facts are which skill
 * covers which location (static/src and static/tests -> odoo-web-guidelines, other addon code ->
 * odoo-guidelines) and that a skill's SKILL.md holds a table of
 * `| [Title](guidelines/x.md#anchor) | Read it when ... |` rows. The table is parsed from the
 * SKILL.md on disk at the start of every run, so updating the skill updates the gate. Rows have
 * ids that are unique in the session: `G1..Gn` for odoo-guidelines, `W1..Wn` for
 * odoo-web-guidelines. The index (id, title, "Read it when") is part of the system prompt (a
 * `<odoo_guideline_index>` section added in `before_agent_start`).
 *
 * Flow, per batch of edits:
 *  1. BLOCK. An edit of addon code without a match is blocked. The block message shows the
 *     intended change next to the index of the file's skill, so the change is compared with the
 *     "Read it when" column, and says what to do next.
 *  2. MATCH. The agent compares the change with the "Read it when" column and calls
 *     `guideline_match { rows }` ONCE with every row that matches (several can match; an empty
 *     list says none does). The result is the guideline SECTION of each row (its heading up to
 *     the next heading of the same or higher level, what the SKILL.md anchor points to).
 *     Deciding what matches by meaning is the agent's job; an extension cannot do it without a
 *     second model. What the extension CAN compare mechanically it compares itself: a "Read it
 *     when" cell that names a path in backticks (`views/`, `security/`, `*.scss`,
 *     `__manifest__.py`) matches every edited file at that path, whatever the agent declared.
 *     Those rows are required too, and their sections are delivered in the block message.
 *  3. CHECK + EDIT. The next message holds ONE `guideline_check { checks }` call FIRST and the
 *     edit calls after it (calls are processed in the order sent, so the edit sees the check,
 *     and the model writes the edit after, and conditioned on, its own compliance analysis).
 *     Each entry names a row, the file the edit touches, ONE rule copied verbatim from that
 *     row's section (the extension verifies the quote is in the section it delivered), whether
 *     the edit complies, and the evidence. Every required row and every file of the batch needs
 *     at least one entry. A `complies: false` entry needs a `fix`: the corrected code as it will
 *     appear in the edit. The edit is approved when its file is covered and its new text
 *     contains each fix, and it differs from a blocked attempt. Otherwise it is blocked and the
 *     violated rules are repeated; the agent adjusts the edit and sends it again (the check
 *     stays valid).
 *
 * Lifetimes. There is no clock: a turn count punishes slow models and says nothing about
 * whether the rules are still in the agent's context, and a check is tied to its edit by
 * content (the quoted rules, the fixes), not by time. The match stays valid until the agent
 * matches again, the session is compacted or restarted (the delivered sections left its
 * context), or, for an empty match ("none applies"), until the batch that used it ends. A match
 * is made for the skills of its rows and of the files whose edits it follows; an edit of a file
 * of another skill needs its own match, and rows of a skill that no edited file belongs to are
 * not required. A check is used by the first batch that passes with it (and by the retry of
 * that batch if an edit failed to apply); the next batch needs a new check but not a new match,
 * so iterating on one kind of change costs one message per edit. The agent calls
 * guideline_match again when its next edit is a different kind of change; rows matched by path
 * never go stale, they are compared on every edit. A file left out of a check is caught when
 * its edit arrives.
 * If a skill's table cannot be parsed, the fallback is "read at least one guideline file of
 * the skill since your last approved edit" and no check.
 *
 * Verified: the quoted rules exist in the delivered sections, every required row and file is
 * covered, a reported violation changed the edit. Not verifiable: that a claimed
 * `complies: true` is true, or that the agent matched every row it should. The end-of-task
 * odoo-review gate is the backstop for that.
 *
 * There is no retry cap and no escape (a human stops a stuck session); the only fail-open is a
 * skill without a SKILL.md or guidelines folder on disk.
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
const SKILL_PREFIX: Record<string, string> = { [CODE_SKILL]: "G", [WEB_SKILL]: "W" };

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
    .replace(/[`*_"'‘’“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The text an edit puts into the file (the replacement texts). */
function newTextOf(input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
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
function intendedChange(input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const items: unknown[] = Array.isArray(input.edits) ? input.edits : [input];
  const parts: string[] = [];
  for (const item of items.slice(0, 5)) {
    const e = (item ?? {}) as Record<string, unknown>;
    const from = str(e.oldText) ?? str(e.oldString);
    const to = str(e.newText) ?? str(e.newString);
    if (to === undefined) continue;
    parts.push((from ? `Replaces:\n${clip(from, 400)}\nwith:\n` : `Inserts:\n`) + clip(to, 800));
  }
  if (items.length > 5) parts.push(`... (+${items.length - 5} more edits)`);
  return parts.join("\n\n");
}

/**
 * The path-like tokens a "Read it when" cell names in backticks: a directory (`views/`), an
 * extension (`*.scss`) or a file name (`__manifest__.py`). Anything else in backticks is code
 * (`@route`, `create`) and says nothing about the file, so it is left to the agent.
 */
const FILE_NAME = /^[\w-]+(?:\.[\w-]+)*\.(?:py|xml|csv|js|ts|scss|css|json|ya?ml|html|po|pot)$/i;
function pathTokens(when: string): string[] {
  const tokens: string[] = [];
  for (const m of when.matchAll(/`([^`\s]+)`/g)) {
    const t = m[1];
    if (/^[\w.-]+\/$/.test(t) || /^\*\.\w+$/.test(t) || FILE_NAME.test(t)) tokens.push(t);
  }
  return tokens;
}

/** Whether a file (path segments relative to its addon) is at one of the path tokens. */
function matchesPath(tokens: string[], rel: string[]): boolean {
  const name = rel[rel.length - 1] ?? "";
  const dirs = rel.slice(0, -1);
  return tokens.some((t) =>
    t.endsWith("/")
      ? dirs.includes(t.slice(0, -1))
      : t.startsWith("*.")
        ? name.toLowerCase().endsWith(t.slice(1).toLowerCase())
        : name === t,
  );
}

interface RowRef {
  id: string; // G3, W2: unique in the session
  skill: string;
  row: IndexRow;
  tokens: string[]; // path tokens of its "Read it when"
}

interface Index {
  rows: Map<string, RowRef>;
  bySkill: Map<string, RowRef[]>;
}

/** All rows of the skills that exist on disk, with their session-wide ids. */
function loadRows(): Index {
  const rows = new Map<string, RowRef>();
  const bySkill = new Map<string, RowRef[]>();
  for (const skill of [CODE_SKILL, WEB_SKILL]) {
    const list = parseIndex(skill).map((row, i) => ({
      id: `${SKILL_PREFIX[skill]}${i + 1}`,
      skill,
      row,
      tokens: pathTokens(row.when),
    }));
    bySkill.set(skill, list);
    for (const r of list) rows.set(r.id, r);
  }
  return { rows, bySkill };
}

const indexLines = (list: RowRef[]) =>
  list.map((r) => `${r.id} | ${r.row.title} | ${r.row.when}`).join("\n");

interface CheckEntry {
  row: string;
  path: string;
  rule: string;
  complies: boolean;
  evidence: string;
  fix?: string; // when complies is false: the corrected text the edit must contain
}

const HOW_TO_MATCH =
  `Compare your change with the "Read it when" column of the guideline index. Call ` +
  `guideline_match ONCE with every row that matches (several can match; an empty list says ` +
  `none does): guideline_match { rows: [ { row: "G3", why: "<what matches>" } ] }. Its result ` +
  `is the guideline section of each row.`;

const HOW_TO_CHECK =
  `Check your edit against the rules you were given. In your NEXT message send ONE ` +
  `guideline_check call FIRST and your edit calls AFTER it (calls are processed in the order ` +
  `sent). guideline_check { checks: [ { row, path, rule, complies, evidence, fix } ] }: one ` +
  `entry for every row to check (more for a row when more of its rules apply); path = the ` +
  `file the edit touches (every file of your edit calls needs an entry); rule = ONE rule ` +
  `copied verbatim from that row's section, preferably the one your edit is most likely to ` +
  `break (the quote is verified); complies = true or false; evidence = what in the edit ` +
  `satisfies the rule, or what is wrong with it. Write the edit AFTER the check, so it ` +
  `reflects it. Where the edit breaks a rule, say complies=false and give fix = the corrected ` +
  `code exactly as it will appear in your edit: an edit that does not contain the fix, or that ` +
  `repeats a blocked attempt, is blocked. An edit that follows every rule is approved.`;

const PROCESS =
  `Edits of addon code (the edit tool; write is not gated) go through the guidelines. ` +
  `${HOW_TO_MATCH} ${HOW_TO_CHECK} The match stays valid for your later edits; call ` +
  `guideline_match again when your next edit is a different kind of change. The extension ` +
  `also matches rows by file path (views/, security/, tests/, ...) and requires those too. ` +
  `An edit sent without a match or a check is blocked, and the message tells you what is ` +
  `missing. Rows G* cover everything outside static/, rows W* cover static/src and ` +
  `static/tests.`;

function indexSection(index: Index): string | undefined {
  const parts: string[] = [];
  for (const [skill, list] of index.bySkill) {
    if (list.length === 0) continue;
    const scope =
      skill === WEB_SKILL ? "for files under static/src and static/tests" : "for all other addon code";
    parts.push(`${skill} (${scope}):\n${indexLines(list)}`);
  }
  return parts.length === 0 ? undefined : `${PROCESS}\n\n${parts.join("\n\n")}`;
}

const signatureOf = (index: Index) =>
  [...index.rows.values()].map((r) => `${r.id}|${r.row.title}|${r.row.when}`).join("\n");

const unstring = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** guideline_match input, tolerant of the shapes weaker models send. */
function matchArguments(args: unknown): { rows: { row: string; why?: string }[] } {
  const a = (typeof args === "string" ? { rows: args } : (args ?? {})) as Record<string, unknown>;
  const raw = unstring(a.rows ?? a.row ?? a.ids ?? []);
  const items: unknown[] = Array.isArray(raw) ? raw : [raw];
  const rows: { row: string; why?: string }[] = [];
  for (const item of items) {
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const text = String(o.row ?? o.id ?? "").trim();
      const id = /\b[GW]\d+\b/i.exec(text)?.[0] ?? text; // "G3 - Imports" is still G3
      if (id) rows.push({ row: id, why: typeof o.why === "string" ? o.why : undefined });
    } else if (typeof item === "string") {
      for (const m of item.matchAll(/\b[GW]\d+\b/gi)) rows.push({ row: m[0] });
    }
  }
  return { rows };
}

/** guideline_check input, tolerant of the shapes weaker models send. */
function checkArguments(args: unknown): { checks: Record<string, unknown>[] } {
  const a = (args ?? {}) as Record<string, unknown>;
  let raw = unstring(a.checks ?? a.check ?? a.entries ?? []);
  if (raw && !Array.isArray(raw) && typeof raw === "object") raw = [raw];
  const list = Array.isArray(raw) ? raw : [];
  return {
    checks: list.map((c) => {
      const o = { ...((unstring(c) as Record<string, unknown>) ?? {}) };
      if (typeof o.complies === "string") o.complies = o.complies.trim().toLowerCase() === "true";
      return o;
    }),
  };
}

export default function (pi: ExtensionAPI) {
  let seq = 0;
  let turn = 0;
  let index = loadRows();
  let signature = signatureOf(index);

  const readSeq = new Map<string, number>(); // skill file -> seq of its latest read
  const blockedIds = new Set<string>(); // calls this extension blocked (not tool failures)
  const delivered = new Map<string, string>(); // row id -> the section the agent was given
  const attempts = new Map<string, Set<string>>(); // file -> hashes of the inputs blocked since the last grant
  // What the agent said matches (rows id -> why) and the skills that match was made for;
  // undefined until guideline_match.
  let declared: { rows: Map<string, string>; skills: Set<string> } | undefined;
  let checks: CheckEntry[] | undefined; // the latest valid guideline_check, not yet used up
  let grantUntil = -1; // -1 until an edit passed; the check serves the batch while turn <= this
  let grantSeq = 0; // seq of the last approved edit (fallback when a table cannot be parsed)

  const reset = () => {
    readSeq.clear();
    blockedIds.clear();
    delivered.clear();
    attempts.clear();
    declared = undefined;
    checks = undefined;
    grantUntil = -1;
  };
  pi.on("session_start", async () => {
    index = loadRows();
    signature = signatureOf(index);
    reset();
  });
  pi.on("session_compact", reset);
  pi.on("turn_start", async () => {
    turn++;
  });

  pi.on("before_agent_start", async (event) => {
    attempts.clear(); // blocked attempts of an earlier run say nothing about this one
    index = loadRows();
    const now = signatureOf(index);
    if (now !== signature) {
      signature = now; // ids may point at other rows now: what was delivered no longer applies
      reset();
    }
    const section = indexSection(index);
    const options = (event as { systemPromptOptions?: { sections?: Record<string, string> } })
      .systemPromptOptions;
    if (section && options) {
      options.sections = options.sections ?? {};
      options.sections.odoo_guideline_index = section;
    }
    return undefined;
  });

  /** A check is used up by the batch it approved: from the next turn on, a new one is needed. */
  const expireGrant = () => {
    if (grantUntil >= 0 && turn > grantUntil) {
      checks = undefined;
      attempts.clear();
      grantUntil = -1;
      if (declared && declared.rows.size === 0) declared = undefined; // "none applies" served one batch
    }
  };

  const rowsOf = (skill: string) => index.bySkill.get(skill) ?? [];
  const pathRowsFor = (skill: string, abs: string) => {
    const rel = addonSegments(abs);
    return rowsOf(skill).filter((r) => r.tokens.length > 0 && matchesPath(r.tokens, rel));
  };

  /** Give the agent the section of a row (and remember it, so a check can quote it). */
  const deliver = (r: RowRef): string => {
    const section = sectionOf(r.row);
    delivered.set(r.id, section);
    readSeq.set(r.row.file, ++seq);
    return `Row ${r.id} (${r.row.title}), guideline section from ${r.row.file}:\n\n${section}`;
  };

  /**
   * The rows a check must cover for these files: the rows whose "Read it when" names their path,
   * and the rows the agent named that belong to the skill of one of the files.
   */
  const requiredRows = (files: string[]): Map<string, string> => {
    const out = new Map<string, string>();
    const skills = new Set<string>();
    for (const file of files) {
      if (!isAddonFile(file)) continue;
      const skill = skillFor(addonSegments(file), file);
      if (!skill) continue;
      skills.add(skill);
      for (const r of pathRowsFor(skill, file)) out.set(r.id, `it matches ${path.basename(file)} by path`);
    }
    for (const id of declared?.rows.keys() ?? []) {
      if (!out.has(id) && skills.has(index.rows.get(id)?.skill ?? "")) out.set(id, "you named it in guideline_match");
    }
    return out;
  };

  /** Validate a guideline_check input; the entries when valid, else what to fix. */
  const parseChecks = (
    input: unknown,
    cwd: string,
  ): { entries?: CheckEntry[]; problems: string[]; sections?: string } => {
    const problems: string[] = [];
    const raw = (input as { checks?: unknown })?.checks;
    if (!Array.isArray(raw) || raw.length === 0) return { problems: ["`checks` is empty."] };
    const entries: CheckEntry[] = [];
    const seen = new Set<string>();
    raw.forEach((e: any, i: number) => {
      const at = `check ${i + 1}`;
      const id = String(e?.row ?? "").trim().toUpperCase();
      const section = delivered.get(id);
      if (section === undefined) {
        problems.push(
          `${at}: row ${e?.row} was not given to you (given: ${[...delivered.keys()].join(", ") || "none"}); ` +
            `name it in guideline_match first.`,
        );
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

    // Rows to check for the files of the entries. A file left out of the check altogether is
    // caught when its edit arrives.
    const required = requiredRows([...new Set(entries.map((c) => c.path))]);
    for (const [id, why] of required) {
      if (!entries.some((c) => c.row === id)) problems.push(`no check for row ${id} (${why}).`);
    }
    if (problems.length) {
      const fresh = [...required.keys()]
        .filter((id) => !delivered.has(id))
        .map((id) => index.rows.get(id)!);
      return { problems, sections: fresh.length ? fresh.map(deliver).join("\n\n---\n\n") : undefined };
    }
    return { entries, problems };
  };

  pi.registerTool({
    name: "guideline_match",
    label: "Guideline match",
    description:
      "Before editing addon code with the edit tool, compare your change with the 'Read it " +
      "when' column of the guideline index (system prompt, section odoo_guideline_index; ids " +
      "like G3, W2) and name EVERY row that matches. Several rows can match; an empty list " +
      "says none does. The result is the guideline section of each row, so that you can check " +
      "your edit against it with guideline_check.",
    promptSnippet:
      "Name the Odoo guideline rows that match your change and get their sections (before editing addon code)",
    promptGuidelines: [
      "Use guideline_match once before an edit of addon code: list every row of the guideline index whose 'Read it when' matches your change; the result is each row's guideline section.",
      "Use guideline_check before the edit of addon code, in the same message and ahead of it, after guideline_match returned the sections; write the edit after the check.",
    ],
    parameters: Type.Object({
      rows: Type.Array(
        Type.Object({
          row: Type.String({ description: 'The row id from the index, such as "G3" or "W2".' }),
          why: Type.Optional(
            Type.String({ description: "A few words: what in your change matches the row's 'Read it when'." }),
          ),
        }),
        { description: "Every row that matches your change; empty when none does." },
      ),
    }),
    prepareArguments: matchArguments,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const reply = (text: string, details: Record<string, unknown> = {}) => ({
        content: [{ type: "text" as const, text }],
        details,
      });
      expireGrant(); // the previous batch is over: its leftovers must not eat this match
      if (index.rows.size === 0) {
        return reply("No guideline index was found, so there is nothing to match; read the guideline files with the read tool.");
      }
      const ids = [...new Set(params.rows.map((r) => r.row.trim().toUpperCase()))];
      const unknown = ids.filter((id) => !index.rows.has(id));
      if (unknown.length > 0) {
        return reply(
          `Unknown row(s) ${unknown.join(", ")}. Row ids are ${[...index.rows.keys()].join(", ")}. Nothing was recorded.`,
        );
      }
      const refs = ids.map((id) => index.rows.get(id)!);
      // The skills this match is for: those of its rows and of the files whose edits it follows.
      const skills = new Set(refs.map((r) => r.skill));
      if (refs.length === 0) {
        skills.add(CODE_SKILL).add(WEB_SKILL); // "none applies", said of the whole index
      } else {
        for (const file of attempts.keys()) {
          const skill = isAddonFile(file) ? skillFor(addonSegments(file), file) : undefined;
          if (skill) skills.add(skill);
        }
      }
      declared = {
        rows: new Map(
          ids.map((id) => [id, params.rows.find((r) => r.row.trim().toUpperCase() === id)?.why?.trim() ?? ""]),
        ),
        skills,
      };
      checks = undefined; // a check made for another set of rows does not serve this one
      if (ids.length === 0) {
        return reply(
          `Recorded: no row matches. The edit is approved unless its file matches rows by path ` +
            `(the block message names them). Send your edit now.`,
        );
      }
      const text = refs.map(deliver).join("\n\n---\n\n");
      return reply(`${text}\n\n---\n\n${HOW_TO_CHECK}`, { files: refs.map((r) => r.row.file) });
    },
  });

  pi.registerTool({
    name: "guideline_check",
    label: "Guideline check",
    description:
      "Check your intended edit against the guideline sections guideline_match gave you, BEFORE " +
      "the edit and in the same message, as the first call. One entry per rule: the row id, the " +
      "file, ONE rule quoted verbatim from that row's section, whether the edit complies, and " +
      "the evidence. At least one entry for every row to check and every file you edit. Where " +
      "complies=false the edit that follows must contain the fix.",
    promptSnippet: "Check an intended addon edit against the guideline sections just given",
    parameters: Type.Object({
      checks: Type.Array(
        Type.Object({
          row: Type.String({ description: 'The row id whose section the rule comes from, such as "G5".' }),
          path: Type.String({ description: "The file the edit touches." }),
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
    prepareArguments: checkArguments as any,
    executionMode: "sequential",
    async execute() {
      const violations = checks?.filter((c) => !c.complies) ?? [];
      const text = !checks
        ? "No guideline check is needed right now."
        : `Check recorded: ${checks.length} rule(s), ${violations.length} violation(s).` +
          (violations.length
            ? ` The edit for ${[...new Set(violations.map((v) => v.path))].join(", ")} must contain ` +
              `the fix you gave for each violated rule.`
            : ` Send your edit now (in this message, after this call).`);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "edit") return undefined;
    if (blockedIds.delete(event.toolCallId)) return undefined; // blocked by us, not failed
    if (!event.isError) return undefined;
    if (grantUntil === turn) grantUntil = turn + 1; // the retry needs no new check
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
      expireGrant();
      if (!declared) {
        return block(
          "No guideline_match yet. Compare your change with the \"Read it when\" column of the " +
            "guideline index and call guideline_match first; its result holds the sections you " +
            "quote in the check. Then send guideline_check again, ahead of your edit.",
        );
      }
      const parsed = parseChecks(event.input, ctx.cwd);
      if (!parsed.entries) {
        return block(
          `guideline_check rejected, nothing recorded:\n` +
            parsed.problems.map((p) => `- ${p}`).join("\n") +
            (parsed.sections
              ? `\n\nRows matched by file path, which you must check too:\n\n${parsed.sections}`
              : ""),
        );
      }
      checks = parsed.entries;
      grantUntil = -1;
      return undefined;
    }

    if (event.toolName !== "edit") return undefined; // write is never gated

    const raw = inputPath(event.input as Record<string, unknown>);
    if (!raw) return undefined;
    const abs = expand(raw, ctx.cwd);
    if (!isAddonFile(abs)) return undefined;
    const skill = skillFor(addonSegments(abs), abs);
    if (!skill) return undefined;
    if (!existsSync(path.join(SKILLS_DIR, skill, "SKILL.md"))) return undefined; // fail open
    const guidelinesDir = path.join(SKILLS_DIR, skill, "guidelines") + path.sep;
    if (!existsSync(guidelinesDir)) return undefined; // fail open

    expireGrant();
    const input = event.input as Record<string, unknown>;
    const hash = inputHash(input);
    const remember = () => {
      const set = attempts.get(abs) ?? new Set<string>();
      set.add(hash);
      attempts.set(abs, set);
    };
    const change = intendedChange(input);
    const short = `Blocked: ${abs}.` + (change ? `\n\nIntended change:\n${change}\n` : "");
    const skillRows = rowsOf(skill);

    if (skillRows.length === 0) {
      const fresh = [...readSeq].some(([f, n]) => f.startsWith(guidelinesDir) && n > grantSeq);
      if (!fresh) {
        remember();
        return block(
          `${short}\nRead at least one guideline file in ${guidelinesDir} that covers your ` +
            `change (any tool), then repeat the edit.`,
        );
      }
      grantUntil = turn;
      grantSeq = ++seq;
      return undefined;
    }

    // The extension's own comparison: rows whose "Read it when" names this file's path.
    const required = requiredRows([abs]);
    const undelivered = [...required.keys()].filter((id) => !delivered.has(id)).map((id) => index.rows.get(id)!);
    const matched = !!declared && declared.skills.has(skill);
    if (!matched || undelivered.length > 0) {
      remember();
      const parts = [short];
      if (!matched) {
        parts.push(
          (declared
            ? `Your guideline_match was made for ${[...declared.skills].join(", ")}, and this file is ` +
              `covered by ${skill}. `
            : "") + `${HOW_TO_MATCH}\n\n${skill} index:\n${indexLines(skillRows)}`,
        );
      }
      const byPath = pathRowsFor(skill, abs);
      if (byPath.length > 0) {
        parts.push(
          `The extension compared your file with the index and matched ` +
            `${byPath.map((r) => r.id).join(", ")} by path (${path.basename(abs)}); they must be ` +
            `checked too.` +
            (undelivered.length > 0
              ? ` Their sections:\n\n${undelivered.map(deliver).join("\n\n---\n\n")}`
              : ""),
        );
      } else if (undelivered.length > 0) {
        parts.push(undelivered.map(deliver).join("\n\n---\n\n"));
      }
      if (matched) {
        parts.push(`Rows to check: ${[...required.keys()].join(", ")}.`);
      }
      parts.push(
        matched
          ? `${HOW_TO_CHECK}\n\nIf a row no longer matches your change, call guideline_match again with the rows that do.`
          : `After guideline_match: ${HOW_TO_CHECK}`,
      );
      return block(parts.join("\n\n"));
    }

    if (required.size === 0) {
      grantUntil = turn; // the agent matched no row of this skill and the path matches none
      return undefined;
    }
    const missing = checks ? [...required.keys()].filter((id) => !checks!.some((c) => c.row === id)) : [...required.keys()];
    if (!checks || missing.length > 0) {
      remember();
      const titles = [...required.keys()].map((id) => `${id} (${index.rows.get(id)?.row.title})`).join(", ");
      return block(
        `${short}\n${checks ? `Your guideline_check does not cover row(s) ${missing.join(", ")}` : "No guideline_check came before this edit"}. ` +
          `Rows to check: ${titles}. ${HOW_TO_CHECK}\n\nIf a row no longer matches your change, ` +
          `call guideline_match again with the rows that do.`,
      );
    }
    const covering = checks.filter((c) => c.path === abs);
    if (covering.length === 0) {
      remember();
      checks = undefined;
      return block(
        `${short}\nYour guideline_check has no entry for ${abs}. Send it again, now covering ` +
          `every file of this batch, before the edits. ${HOW_TO_CHECK}`,
      );
    }
    const violated = covering.filter((c) => !c.complies);
    const written = norm(newTextOf(input));
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
    if (violated.length > 0 && attempts.get(abs)?.has(hash)) {
      return block(
        `${short}\nYour own guideline_check reports a violation for this file, but the edit is the ` +
          `same as the blocked attempt. Change it so that it follows the rule(s), then send it ` +
          `again; the check stays valid.`,
      );
    }
    grantUntil = turn;
    return undefined;
  });
}
