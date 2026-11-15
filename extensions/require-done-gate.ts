/**
 * require-done-gate: do not let the agent end its turn while the work is not provably done.
 *
 * Why: in a long autonomous session nobody reviews between rounds, and an agent that is
 * tired of the task simply says "done". Prose in AGENTS.md cannot stop that, so this
 * extension checks, when the agent is about to stop, facts it can verify itself:
 *
 *  1. Ledger: `<odoo base>/log/*_progress.md` (the newest one) holds a requirement table
 *     (columns "MUST/SHOULD" and "Status"). Every MUST row is `verified` and at least 90%
 *     of all rows are `verified`.
 *  2. Fresh green run: a full-module test run (`--test-tags` with a bare `/<module>`, no
 *     `:Class`) whose log shows `odoo.tests.result ... 0 failed, 0 error(s) of N tests`
 *     with N > 0 finished AFTER the last code edit.
 *  3. Clean tree: `git status --porcelain` is empty in the repos the agent edited.
 *
 * The gate only applies once the agent has edited code in this session, so questions and
 * read-only work are never held. If a check fails, the agent is sent back to work with the
 * exact reason (it cannot just reply). There is deliberately NO retry cap: the agent keeps
 * working until the checks pass. The only way out is a line `NEEDS-HUMAN: <reason>` in the
 * progress file (a genuine blocker only the human can resolve), or the human interrupting
 * the session. A wrong check therefore loops until someone looks, so each nudge is shown
 * in the session (display: true) with the exact failing checks.
 *
 * The ledger is written by the agent, so check 1 only catches laziness; checks 2 and 3 read
 * the log and git directly. Everything resets on `session_start`.
 *
 * Install: copy to ~/.pi/agent/extensions/require-done-gate.ts and run /reload.
 * Env: ODOO_PROGRESS_DIR overrides the ledger directory (default ~/src/odoo/log).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MIN_VERIFIED_RATIO = 0.9;
const PROGRESS_DIR = path.resolve(
  process.env.ODOO_PROGRESS_DIR || path.join(os.homedir(), "src", "odoo", "log"),
);
const SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");

function expand(p: string, cwd: string): string {
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

function inputPath(input: Record<string, unknown>): string | undefined {
  const raw = input.path ?? input.file_path ?? input.filePath;
  return typeof raw === "string" && raw ? raw : undefined;
}

/** Files that are not "the work": logs, scratch, the ledger itself, installed skills. */
function isCodeEdit(abs: string): boolean {
  if (abs.startsWith(PROGRESS_DIR + path.sep)) return false;
  if (abs.startsWith(SKILLS_DIR + path.sep)) return false;
  if (abs.startsWith("/tmp/")) return false;
  if (path.basename(abs).endsWith("_progress.md")) return false;
  return true;
}

// ---------------------------------------------------------------- ledger

interface Ledger {
  file: string;
  rows: { id: string; kind: "MUST" | "SHOULD"; status: string }[];
  needsHuman: boolean;
}

function newestProgressFile(): string | undefined {
  try {
    const files = readdirSync(PROGRESS_DIR)
      .filter((f) => f.endsWith("_progress.md"))
      .map((f) => path.join(PROGRESS_DIR, f));
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0];
  } catch {
    return undefined;
  }
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
const plain = (s: string) => s.replace(/[`*_]/g, "").trim().toLowerCase();

/** Parse the first table whose header has a MUST/SHOULD column and a Status column. */
function parseLedger(file: string): Ledger {
  const text = readFileSync(file, "utf8");
  const ledger: Ledger = { file, rows: [], needsHuman: /^\s*NEEDS-HUMAN:/m.test(text) };
  let kindCol = -1;
  let statusCol = -1;
  let idCol = 0;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) {
      if (ledger.rows.length) break; // table ended
      kindCol = statusCol = -1;
      continue;
    }
    const c = cells(line);
    if (kindCol < 0) {
      const names = c.map(plain);
      const k = names.findIndex((n) => n.includes("must"));
      const s = names.findIndex((n) => n === "status");
      if (k >= 0 && s >= 0) {
        kindCol = k;
        statusCol = s;
        idCol = Math.max(0, names.findIndex((n) => n === "#" || n === "id"));
      }
      continue;
    }
    if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue; // separator
    const kind = plain(c[kindCol] ?? "");
    if (kind !== "must" && kind !== "should") continue;
    ledger.rows.push({
      id: c[idCol] || String(ledger.rows.length + 1),
      kind: kind === "must" ? "MUST" : "SHOULD",
      status: plain(c[statusCol] ?? ""),
    });
  }
  return ledger;
}

// ------------------------------------------------------------ test runs

/** A full-module run: `--test-tags` with a bare `/<module>` positive tag (no `:Class`). */
export function isFullSuiteCommand(command: string): boolean {
  if (!/odoo-bin/.test(command)) return false;
  const m = command.match(/--test-tags(?:=|\s+)(?:'([^']*)'|"([^"]*)"|(\S+))/);
  if (!m) return false;
  const tags = (m[1] ?? m[2] ?? m[3] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const positive = tags.filter((t) => !t.startsWith("-"));
  return positive.length > 0 && positive.every((t) => /^\+?\/[\w]+$/.test(t));
}

/** Green = at least one result line, all `0 failed, 0 error(s)`, and N > 0. */
export function greenFromLog(text: string): { green: boolean; detail: string } {
  const lines = text.split("\n").filter((l) => l.includes("odoo.tests.result"));
  if (!lines.length) return { green: false, detail: "no odoo.tests.result line" };
  for (const l of lines) {
    const m = l.match(/(\d+) failed, (\d+) error\(s\) of (\d+) tests/);
    if (!m) continue;
    if (m[1] !== "0" || m[2] !== "0") return { green: false, detail: l.trim() };
    if (m[3] === "0") return { green: false, detail: "N = 0 tests" };
  }
  return { green: true, detail: lines[lines.length - 1].trim() };
}

function logfileOf(command: string, cwd: string): string | undefined {
  const m = command.match(/--logfile(?:=|\s+)(?:'([^']+)'|"([^"]+)"|(\S+))/);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3];
  return raw ? expand(raw, cwd) : undefined;
}

// ------------------------------------------------------------------ git

function dirtyFiles(dir: string): string[] {
  try {
    const out = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return []; // not a repo or git missing: nothing to check
  }
}

function repoRoot(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ extension

export default function (pi: ExtensionAPI) {
  let seq = 0;
  let lastEdit = 0;
  let lastGreen = 0;
  let lastGreenDetail = "";
  const editedDirs = new Set<string>();
  const pending = new Map<string, string>(); // toolCallId -> bash command
  let nudges = 0; // only numbers the messages

  const reset = () => {
    seq = lastEdit = lastGreen = nudges = 0;
    lastGreenDetail = "";
    editedDirs.clear();
    pending.clear();
  };
  pi.on("session_start", reset);

  pi.on("before_agent_start", async (event) => {
    if ((event as { messageType?: string }).messageType === "user") nudges = 0;
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const raw = inputPath(event.input as Record<string, unknown>);
      if (!raw) return undefined;
      const abs = expand(raw, ctx.cwd);
      if (isCodeEdit(abs)) {
        lastEdit = ++seq;
        editedDirs.add(path.dirname(abs));
      }
    } else if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (isFullSuiteCommand(command)) pending.set(event.toolCallId, command);
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const command = pending.get(event.toolCallId);
    if (event.toolName !== "bash" || command === undefined) return undefined;
    pending.delete(event.toolCallId);
    if (event.isError) return undefined; // non-zero exit never counts as green
    let text = "";
    const logfile = logfileOf(command, ctx.cwd);
    try {
      if (logfile && existsSync(logfile)) text = readFileSync(logfile, "utf8");
    } catch {
      /* fall through to stdout */
    }
    if (!text.includes("odoo.tests.result")) {
      text = (event.content ?? [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
    }
    const { green, detail } = greenFromLog(text);
    if (green) {
      lastGreen = ++seq;
      lastGreenDetail = detail;
    }
    return undefined;
  });

  pi.on("agent_before_settle", async (event) => {
    if (lastEdit === 0) return undefined; // no code touched: nothing to gate
    if (event.outcome !== "completed") return undefined; // errors/aborts are hard exits

    const problems: string[] = [];
    const file = newestProgressFile();
    let needsHuman = false;

    // 1. Ledger
    if (!file) {
      problems.push(
        `No ledger found: write your requirement table to ${PROGRESS_DIR}/<task>_progress.md ` +
          `(columns # | Requirement | MUST/SHOULD | Test | Evidence | Status).`,
      );
    } else {
      const ledger = parseLedger(file);
      needsHuman = ledger.needsHuman;
      if (ledger.rows.length === 0) {
        problems.push(
          `${file} has no requirement rows (a table with MUST/SHOULD and Status columns).`,
        );
      } else {
        const openMust = ledger.rows.filter((r) => r.kind === "MUST" && r.status !== "verified");
        if (openMust.length) {
          problems.push(
            `MUST rows not verified: ${openMust.map((r) => `#${r.id} (${r.status || "no status"})`).join(", ")}. ` +
              `Verify them (test seen red, then green, evidence recorded) or mark blocked with a reason.`,
          );
        }
        const verified = ledger.rows.filter((r) => r.status === "verified").length;
        const ratio = verified / ledger.rows.length;
        if (ratio < MIN_VERIFIED_RATIO) {
          problems.push(
            `Only ${verified}/${ledger.rows.length} ledger rows are verified ` +
              `(${Math.round(ratio * 100)}%, need at least ${MIN_VERIFIED_RATIO * 100}%).`,
          );
        }
      }
    }

    // 2. Fresh green full-suite run
    if (lastGreen <= lastEdit) {
      problems.push(
        lastGreen === 0
          ? `No green full-module test run seen this session. Run the module gate ` +
              `(--test-tags '/<module>', fresh log) and read odoo.tests.result with N > 0.`
          : `Code was edited after the last green full-module run (${lastGreenDetail}). ` +
              `Re-run the module gate on a fresh log.`,
      );
    }

    // 3. Clean tree
    const roots = new Set<string>();
    for (const dir of editedDirs) {
      const root = existsSync(dir) ? repoRoot(dir) : undefined;
      if (root) roots.add(root);
    }
    for (const root of roots) {
      const dirty = dirtyFiles(root);
      if (dirty.length) {
        const shown = dirty.slice(0, 15).join("\n  ");
        problems.push(
          `git status is not clean in ${root} (${dirty.length} entries):\n  ${shown}` +
            `${dirty.length > 15 ? "\n  ..." : ""}\n` +
            `Commit the intended changes (odoo-git skill) and delete stray files and any ` +
            `leftover deliberate break.`,
        );
      }
    }

    if (problems.length === 0) {
      nudges = 0;
      return undefined;
    }
    if (needsHuman) return undefined; // agent declared a blocker for the human
    nudges++;

    const content =
      `You are not done yet (check #${nudges}). Checks that failed:\n` +
      problems.map((p, i) => `${i + 1}. ${p}`).join("\n") +
      `\nFix them and continue. Do not report completion until they pass. If you are ` +
      `genuinely blocked on something only the human can resolve, add a line ` +
      `\`NEEDS-HUMAN: <what blocks you and what you tried>\` to the progress file and stop.`;
    return {
      entries: [
        ...event.entries,
        { type: "custom_message", customType: "done-gate", content, display: true },
      ],
      continue: true,
    };
  });
}
