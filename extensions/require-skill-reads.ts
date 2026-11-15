/**
 * require-skill-reads: make the agent actually READ the Odoo skill guidelines.
 *
 * Why: Pi only advertises a skill's name and description; the model must open the files
 * itself and often does not (and `SKILL.md` is only an index, the rules live in
 * `guidelines/*.md`). Prose in AGENTS.md cannot force that, so this extension does.
 *
 * Nothing about individual guideline files is hard-coded. The only fixed facts are which
 * skill covers which kind of file (static/src and static/tests -> odoo-web-guidelines,
 * other addon code -> odoo-guidelines). Everything else is read from that skill's own
 * SKILL.md at the moment of the edit, so updating the skill updates the gate.
 *
 * Before an `edit` / `write` of an addon code file the agent must have, in this session:
 *  1. read the skill's SKILL.md (the index), and
 *  2. read every guideline file whose index row names this kind of file (a row matches
 *     when a backticked path token in its "Read it when" text, such as `tests/`, `views/`,
 *     `__manifest__.py` or `*.scss`, matches the edited path), and
 *  3. read at least one guideline file of that skill (the agent picks it from the index
 *     when no row names the file).
 * If not, the edit is blocked and the block message lists exactly what to read, including
 * the index rows to choose from. SKILL.md counts only when opened with the `read` tool (a
 * bash `cat` of it is rejected on the spot); guideline files count when read with the
 * `read` tool or with bash `cat`/`head`/`sed`/... (models often use bash).
 *
 * Forgets everything on `session_compact` and `session_start`. There is no retry cap: the
 * edit stays blocked until the files are read (a human stops a stuck session). The only
 * fail-open is a missing SKILL.md on disk, which means no requirement.
 *
 * Install: copy to ~/.pi/agent/extensions/require-skill-reads.ts and run /reload.
 * Override the skills directory with PI_SKILLS_DIR (default ~/.pi/agent/skills).
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_LISTED_ROWS = 30;
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

/** Which skill governs this file, or undefined when it is not covered code. */
function skillFor(abs: string): string | undefined {
  const segs = abs.split(path.sep);
  const ext = path.extname(abs).toLowerCase();
  const staticIdx = segs.lastIndexOf("static");
  if (staticIdx >= 0) {
    // static/src and static/tests are code; static/lib, description, img are not ours.
    if (!["src", "tests"].includes(segs[staticIdx + 1] ?? "")) return undefined;
    return [".js", ".ts", ".xml", ".scss", ".css"].includes(ext) ? WEB_SKILL : undefined;
  }
  return [".py", ".xml", ".csv"].includes(ext) ? CODE_SKILL : undefined;
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

/** Does a backticked path token from a row's "Read it when" text name the edited file? */
function rowMatches(row: IndexRow, abs: string): boolean {
  const segs = abs.split(path.sep);
  const base = path.basename(abs);
  for (const t of row.when.matchAll(/`([^`]+)`/g)) {
    const token = t[1].trim();
    if (!token || token.startsWith("@") || /\s/.test(token)) continue;
    if (token.endsWith("/")) {
      if (segs.includes(token.slice(0, -1))) return true; // `tests/`, `views/`
    } else if (token.includes("*")) {
      const glob = new RegExp(
        "^" + token.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      if (glob.test(base)) return true; // `*.scss`
    } else if (token.includes(".")) {
      if (base === token) return true; // `__manifest__.py`, `ir.access.csv`
    }
  }
  return false;
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

export default function (pi: ExtensionAPI) {
  const loaded = new Set<string>(); // absolute paths of skill files read this session

  const reset = () => {
    loaded.clear();
  };
  pi.on("session_start", reset);
  pi.on("session_compact", reset);

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
      const files = skillFilesReadBy(command, ctx.cwd);
      // SKILL.md is the index and must be opened with the read tool; guideline files may
      // be read with any tool. Reject a bash read of an index right away (cheaper than
      // letting the edit fail later) and do not record anything from that command.
      const indexes = files.filter((file) => path.basename(file) === "SKILL.md");
      if (indexes.length > 0) {
        return {
          block: true,
          reason:
            `Open skill index files with the read tool, not bash:\n` +
            indexes.map((file) => `- ${file}`).join("\n") +
            `\n(Guideline files under guidelines/ may be read with any tool.)`,
        };
      }
      for (const abs of files) loaded.add(abs);
      return undefined;
    }
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

    const raw = inputPath(event.input as Record<string, unknown>);
    if (!raw) return undefined;
    const abs = expand(raw, ctx.cwd);
    if (!isAddonFile(abs)) return undefined;
    const skill = skillFor(abs);
    if (!skill) return undefined;
    const skillMd = path.join(SKILLS_DIR, skill, "SKILL.md");
    if (!existsSync(skillMd)) return undefined; // fail open

    const rows = parseIndex(skill);
    const matched = [...new Set(rows.filter((r) => rowMatches(r, abs)).map((r) => r.file))];
    const guidelinesDir = path.join(SKILLS_DIR, skill, "guidelines") + path.sep;
    const anyGuideline = [...loaded].some((f) => f.startsWith(guidelinesDir));

    const missing: string[] = [];
    if (!loaded.has(skillMd)) {
      missing.push(`${skillMd}  (the index: which guideline covers what; use the read tool)`);
    }
    for (const file of matched) {
      if (loaded.has(file)) continue;
      const row = rows.find((r) => r.file === file)!;
      missing.push(`${file}  (${row.title}: ${row.when})`);
    }
    const needPick = matched.length === 0 && !anyGuideline;
    if (missing.length === 0 && !needPick) return undefined;

    let reason = `Blocked: load the Odoo guidelines for this file before editing ${abs}.\n`;
    if (missing.length) {
      reason += `Read these first (SKILL.md with the read tool; guideline files with any tool), then repeat the edit:\n`;
      reason += missing.map((line) => `- ${line}`).join("\n") + "\n";
    }
    if (needPick) {
      reason +=
        `No index row names this file type, so also read at least one guideline file that ` +
        `${skill}/SKILL.md says covers your change. Its index lists:\n`;
      const byFile = new Map<string, string[]>();
      for (const row of rows) {
        byFile.set(row.file, [...(byFile.get(row.file) ?? []), `${row.title}: ${row.when}`]);
      }
      for (const [file, topics] of [...byFile].slice(0, MAX_LISTED_ROWS)) {
        reason += `- ${file}  (${topics.join("; ")})\n`;
      }
    }
    reason +=
      `SKILL.md is only an index; the rules are in the guidelines/ files it links ` +
      `(relative to its skill directory). They must be read again after a context ` +
      `reset or compaction.`;
    return { block: true, reason };
  });
}
