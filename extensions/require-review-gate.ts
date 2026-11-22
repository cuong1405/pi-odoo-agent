/**
 * require-review-gate: the agent may not stop working until it has reviewed its own work with
 * the odoo-review skill against the task requirements and the review bar is met. After every
 * compaction it is told where the task stands and what to do next.
 *
 * Why: in a long autonomous session nobody reviews between rounds, and an agent working from
 * a bloated context gives up ("scope too large", "missing infrastructure") or says "done".
 * Prose in AGENTS.md cannot stop that, and neither can the model's own summary of a long
 * session. Two things work: holding the turn open where the agent tries to stop, and
 * rebuilding the state of the task from the FILE and git (not from memory) whenever the
 * context was compacted, so the agent resumes from the highest-priority open item.
 *
 * One file is the single source of truth: `<log dir>/<task>_requirements.md`, which the agent
 * writes with the odoo-task-requirements skill. The review is recorded in that same file: a
 * Verdict and an Evidence cell on every requirement row, and a closing `## Review` section
 * (files reviewed, findings table, `Guidelines read:` line). There is no separate report.
 *
 *  0. If no requirements file exists when the agent tries to finish, the gate does not run:
 *     the agent is sent back once, only to tell the human in its final message that the file
 *     was missing and the work was not reviewed.
 *  1. Work in flight: the agent edited code, or wrote a requirements file, in this session
 *     (remembered across /reload and resume through a session entry). When it tries to
 *     finish it is sent to review its own work: load the odoo-review skill NOW (a fresh read
 *     of its SKILL.md after this request), follow ALL of that skill's instructions strictly
 *     (nothing of the skill is restated here), and record the review in the requirements file.
 *  2. Each later attempt to finish is checked against facts the extension can verify,
 *     because the agent writes the review itself and cannot be trusted to grade itself:
 *     - the requirements file was written after the request and has a `## Review` section;
 *     - the skill was read after the request, and every guideline file named on the
 *       `Guidelines read:` line was opened after the request (tracked from read/cat calls);
 *     - the file has a `Base:` commit, and every file changed since it (committed,
 *       uncommitted, untracked, in the repos the agent edited) appears in the Review section,
 *       so the review covers the whole task;
 *     - every numbered requirement row has Verdict `met` with non-empty evidence for every
 *       MUST row, and at least 90% of all rows (the 90% is the tolerance for a task text that
 *       is not 100% accurate, so it only ever forgives SHOULD rows);
 *     - at least 90% of the findings are `fixed` AND name a commit hash that exists in the
 *       repo and is reachable from HEAD.
 *     Otherwise the agent goes back to work on the open items.
 *
 * Every message that sends the agent back has two parts, both computed from the file and git:
 *  - Task state: requirements (MUST/SHOULD counts), the review if it was written (met count,
 *    each unmet MUST with its text and Check, open findings), and per repo the commits since
 *    `Base:` and the uncommitted files.
 *  - Next steps, highest priority first: no review -> write it; unmet MUSTs; open findings;
 *    the 90% bar; changed files missing from the review; format problems.
 *
 * Compaction. A bloated context is the usual cause of premature exits, so before sending the
 * message the gate compacts the session (`ctx.compact`, from `agent_settled`, with
 * instructions that keep the requirement ids and the open problems), but only when the
 * context is above COMPACT_TOKENS (51k, 40% of a 128k window), because a summary of a small
 * context only costs a model call. The message is then sent as a custom message that
 * starts a new turn (not a user prompt, so the review stage is not restarted). If compaction
 * fails or has nothing to do, the message is sent anyway.
 * Any other compaction (the human's /compact, Pi's automatic one) is followed by a "task
 * state + next steps" message with the same content, delivered with the next LLM call
 * (steered into a running turn; stored for the next prompt when Pi is idle).
 *
 * A review with no findings says `No findings.` in the Review section.
 *
 * There is no retry cap and no escape hatch the agent can use: it keeps working until the
 * bar is met, and the human interrupts the session if it is stuck. The one exception is a
 * stalled agent: when the gate has run more than 3 times in a row and no edit/write call (any
 * file, the requirements file included) happened between the runs, the gate lets the agent
 * stop and shows the human a warning with what is still open. A new user prompt starts the
 * review stage again. State that must survive /reload and resume (code edited, requirements
 * file written, repos edited) is stored with `pi.appendEntry` and restored on `session_start`.
 *
 * Install: copy to ~/.pi/agent/extensions/require-review-gate.ts and run /reload.
 * Env: ODOO_LOG_DIR overrides the log directory (default ~/src/odoo/log);
 *      PI_SKILLS_DIR overrides the skills directory (default ~/.pi/agent/skills).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MIN_FIXED_RATIO = 0.9;
const MIN_MET_RATIO = 0.9;
const MAX_IDLE_RUNS = 3;
/**
 * Context size (tokens) above which the gate compacts: 40% of a 128k window. Models stop
 * working reliably well before their advertised window, so the number is fixed instead of
 * scaling with it, and a summary of a smaller context only costs a model call.
 */
const COMPACT_TOKENS = 51_000;
const COMPACT_INSTRUCTIONS =
  "Checkpoint of a long Odoo task. Keep: the task and the path of its requirements file " +
  "(<task>_requirements.md) with its Base commit, the numbers of the requirements still not " +
  "met, every file changed and commit made, the commands and tests run with their results, " +
  "and every problem still open. Drop exploration and long tool output. Do not record a time " +
  "limit, an effort limit or missing infrastructure as a constraint: there is none, and the " +
  "environment is described in AGENTS.md.";
const STATE_ENTRY = "review-gate-state";
const LOG_DIR = path.resolve(
  process.env.ODOO_LOG_DIR || path.join(os.homedir(), "src", "odoo", "log"),
);
const SKILLS_DIR = path.resolve(
  process.env.PI_SKILLS_DIR || path.join(os.homedir(), ".pi", "agent", "skills"),
);
const REVIEW_SKILL_MD = path.join(SKILLS_DIR, "odoo-review", "SKILL.md");

function expand(p: string, cwd: string): string {
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

function inputPath(input: Record<string, unknown>): string | undefined {
  const raw = input.path ?? input.file_path ?? input.filePath;
  return typeof raw === "string" && raw ? raw : undefined;
}

/** Files that are not "the work": logs and the requirements file, scratch, installed skills. */
function isCodeEdit(abs: string): boolean {
  if (abs.startsWith(LOG_DIR + path.sep)) return false;
  if (abs.startsWith(SKILLS_DIR + path.sep)) return false;
  if (abs.startsWith("/tmp/")) return false;
  return true;
}

// ---------------------------------------------------------- requirements file

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
const plain = (s: string) => s.replace(/[`*_]/g, "").trim().toLowerCase();

interface Table {
  header: string[];
  rows: string[][];
}

function parseTables(text: string): Table[] {
  const tables: Table[] = [];
  let current: Table | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) {
      current = undefined;
      continue;
    }
    const c = cells(line);
    if (!current) {
      current = { header: c.map(plain), rows: [] };
      tables.push(current);
    } else if (!c.every((x) => /^:?-{2,}:?$/.test(x))) {
      current.rows.push(c);
    }
  }
  return tables;
}

const colOf = (t: Table, pred: (name: string) => boolean) => t.header.findIndex(pred);

interface Finding {
  id: string;
  where: string;
  fix: string;
  status: string;
}

interface Row {
  id: string;
  kind: string; // "must" or "should"
  text: string;
  check: string;
  verdict: string; // "met", "not met" or "" before the review
  evidence: string;
}

interface Task {
  file: string;
  mtime: number;
  base?: string;
  rows: Row[];
  /** The closing `## Review` section; undefined until the agent has written it. */
  review?: {
    text: string;
    guidelinesLine: string;
    noFindings: boolean;
    findings: Finding[];
  };
}

/** The `## Review` section: `Guidelines read:` line, `No findings.` and the findings table. */
function parseReviewSection(text: string): NonNullable<Task["review"]> {
  const lines = text.split("\n");
  const gi = lines.findIndex((l) => /^\s*[*_]*guidelines read[*_]*\s*:/i.test(l));
  let guidelinesLine = "";
  if (gi >= 0) {
    for (let i = gi; i < lines.length && (i === gi || lines[i].trim() !== ""); i++) {
      guidelinesLine += " " + lines[i];
    }
    guidelinesLine = guidelinesLine.replace(/^\s*[*_]*guidelines read[*_]*\s*:[*_]*/i, "").trim();
  }
  const review = { text, guidelinesLine, noFindings: /\bno findings\b/i.test(text), findings: [] as Finding[] };
  for (const t of parseTables(text)) {
    const st = colOf(t, (n) => n === "status");
    const wh = colOf(t, (n) => n.includes("file"));
    const fx = colOf(t, (n) => n === "fix");
    const id = Math.max(0, colOf(t, (n) => n === "#" || n === "id"));
    if (st < 0 || wh < 0) continue;
    for (const r of t.rows) {
      if (!r[st]) continue;
      review.findings.push({
        id: r[id] || String(review.findings.length + 1),
        where: r[wh] || "",
        fix: fx >= 0 ? r[fx] || "" : "",
        status: plain(r[st]),
      });
    }
  }
  return review;
}

/** Requirement rows (numbered, MUST/SHOULD, with Verdict/Evidence), `Base:` commit, the review. */
function parseTask(file: string): Task {
  const text = readFileSync(file, "utf8");
  const baseLine = text.match(/^\s*[*_]*base[*_]*\s*:\s*(.+)$/im)?.[1] ?? "";
  const task: Task = {
    file,
    mtime: statSync(file).mtimeMs,
    base: baseLine.match(/\b[0-9a-f]{7,40}\b/)?.[0],
    rows: [],
  };
  const at = text.search(/^##\s+review\b/im);
  for (const t of parseTables(at >= 0 ? text.slice(0, at) : text)) {
    const kind = colOf(t, (n) => n.includes("must"));
    const req = colOf(t, (n) => n.includes("requirement"));
    const chk = colOf(t, (n) => n === "check");
    const vd = colOf(t, (n) => n === "verdict");
    const ev = colOf(t, (n) => n.includes("evidence"));
    if (kind < 0 || req < 0) continue;
    for (const r of t.rows) {
      if (!/^\d+$/.test(plain(r[0] ?? ""))) continue;
      if (/superseded/i.test(r.join(" "))) continue;
      task.rows.push({
        id: plain(r[0]),
        kind: plain(r[kind] ?? ""),
        text: (r[req] ?? "").trim(),
        check: chk >= 0 ? (r[chk] ?? "").trim() : "",
        verdict: vd >= 0 ? plain(r[vd] ?? "") : "",
        evidence: ev >= 0 ? (r[ev] ?? "").trim() : "",
      });
    }
  }
  if (at >= 0) task.review = parseReviewSection(text.slice(at));
  return task;
}

const isMet = (r: Row) => r.verdict === "met" && r.evidence.length > 0;

function newestLogFileSince(suffix: string, minMtimeMs: number): string | undefined {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.endsWith(suffix))
      .map((f) => path.join(LOG_DIR, f))
      .filter((f) => statSync(f).mtimeMs >= minMtimeMs && statSync(f).size > 0);
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0];
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ git

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function repoRoot(dir: string): string | undefined {
  return existsSync(dir) ? git(dir, ["rev-parse", "--show-toplevel"])?.trim() : undefined;
}

/** Files changed since `base` (committed, uncommitted and untracked), per repo root. */
function changedSince(roots: Set<string>, base: string): { root: string; file: string }[] {
  const out: { root: string; file: string }[] = [];
  for (const root of roots) {
    if (git(root, ["cat-file", "-e", `${base}^{commit}`]) === undefined) continue;
    const tracked = git(root, ["diff", "--name-only", base]) ?? "";
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]) ?? "";
    for (const f of new Set([...tracked.split("\n"), ...untracked.split("\n")])) {
      if (f.trim()) out.push({ root, file: f.trim() });
    }
  }
  return out;
}

/** A `fixed` finding must name a real commit that is reachable from HEAD. */
function hasRealCommit(fix: string, roots: Set<string>): boolean {
  for (const sha of fix.match(/\b[0-9a-f]{7,40}\b/g) ?? []) {
    for (const root of roots) {
      if (git(root, ["cat-file", "-e", `${sha}^{commit}`]) === undefined) continue;
      if (git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== undefined) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------ the review

function reviewRequest(requirementsFile: string): string {
  return (
    `You are about to finish, so review your own work first (this is the last step):\n` +
    `   a. Load the review skill now: open ${REVIEW_SKILL_MD} with the read tool (even if you ` +
    `read it earlier) and follow ALL of its instructions strictly, every section and not ` +
    `only its numbered process. Work from the skill itself, not from memory or from this ` +
    `message. Its sibling guideline files must be opened again for this review.\n` +
    `   b. Scope: the whole task, from the \`Base:\` commit in ${requirementsFile} to HEAD, ` +
    `plus uncommitted and untracked files. Every changed file must be listed in your review ` +
    `(the skill's Map step).\n` +
    `   c. Check every requirement in ${requirementsFile}. Run its Check yourself now; do not ` +
    `mark anything met from memory or from an earlier run. In the requirements table of that ` +
    `file, fill in for every row (overwrite earlier values) the Verdict cell, \`met\` or ` +
    `\`not met\`, and the Evidence cell: what you ran or read for this review (command and ` +
    `result line, test name, log line, PNG path), never a claim. Every MUST requirement must ` +
    `be \`met\`, and at least ${MIN_MET_RATIO * 100}% of all requirements (SHOULD included).\n` +
    `   d. Record the review in the same file, as a \`## Review\` section at the END of it (the ` +
    `only place the review is written: no separate report file), with:\n` +
    `      Files reviewed: <every changed file>\n` +
    `      the findings, in the skill's report format, as a table with exactly these columns ` +
    `(the skill's finding fields plus Status)\n` +
    `      | # | File:line | Defect | Failure scenario | Fix | Guideline section or *judgement* | Status |\n` +
    `      A finding is a defect in the code or a gap against a requirement, not a ` +
    `description of what you changed. A weakened test, relaxed threshold or shortfall against ` +
    `a requirement is a finding even if you believe it is justified. Status starts as ` +
    `\`open\`. With no findings, write \`No findings.\` instead of the table.\n` +
    `      Guidelines read: <the guideline files you opened for this review, for example ` +
    `odoo-guidelines/python.md; each must have been opened after this request>\n` +
    `   e. Fix every finding you can (with a test that covers it) and commit; set Status to ` +
    `\`fixed\` and put the commit hash in the Fix cell. Leave an ambiguous one \`flagged\` with ` +
    `the reason in its Fix cell. At least ${MIN_FIXED_RATIO * 100}% of the findings must be ` +
    `\`fixed\` with a commit that exists in the repository.`
  );
}

interface ReviewContext {
  requestTime: number;
  skillReadAfterRequest: boolean;
  guidelineReadsAfterRequest: Set<string>; // basenames of skill .md files opened after the request
  roots: Set<string>;
  requirementsFile: string;
}

interface Problem {
  priority: number; // lower is more urgent
  text: string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}...` : text);

function list(items: string[], cap = 25): string {
  return items.slice(0, cap).join("; ") + (items.length > cap ? `; ... (+${items.length - cap} more)` : "");
}

/**
 * What is wrong with the review, most urgent first: work on the task itself (unmet MUSTs, open
 * findings, the 90% bar), then the files the review misses, then problems of its format. With
 * no review written since the request the one step is to write it.
 */
function reviewProblems(c: ReviewContext): Problem[] {
  const problems: Problem[] = [];
  const add = (priority: number, text: string) => problems.push({ priority, text });
  const file = c.requirementsFile;
  const task = parseTask(file);
  const review = task.review;
  if (!review || task.mtime < c.requestTime) {
    add(
      0,
      `The review is not recorded in ${file} since it was requested: fill in the Verdict and ` +
        `Evidence cells of the requirements table and add the closing \`## Review\` section ` +
        `(Files reviewed, findings table or \`No findings.\`, \`Guidelines read:\` line). ` +
        `Do not write a separate report file.`,
    );
    if (!c.skillReadAfterRequest) {
      add(0, `Open ${REVIEW_SKILL_MD} with the read tool first, then review per all of its instructions.`);
    }
    return problems;
  }
  if (!c.skillReadAfterRequest) {
    add(
      5,
      `The review skill was not loaded since the review was requested: open ` +
        `${REVIEW_SKILL_MD} with the read tool, then review per all of its instructions.`,
    );
  }

  const claimed = [...new Set(review.guidelinesLine.match(/[\w.-]+\.md\b/g) ?? [])];
  if (!review.guidelinesLine) {
    add(5, `The \`## Review\` section of ${file} has no closing \`Guidelines read: <files>\` line.`);
  } else if (claimed.length === 0) {
    add(5, `The \`Guidelines read:\` line names no guideline file (for example odoo-guidelines/python.md).`);
  } else {
    const unread = claimed.filter((f) => !c.guidelineReadsAfterRequest.has(f));
    if (unread.length) {
      add(
        5,
        `\`Guidelines read:\` names files you did not open since the review was requested: ` +
          `${unread.join(", ")}. Open them now (the skill requires reading them fresh for every ` +
          `review) or remove them from the line.`,
      );
    }
  }

  if (task.rows.length === 0) {
    add(
      5,
      `${file} has no numbered requirement rows (table with # | Requirement | MUST/SHOULD ` +
        `columns, as the odoo-task-requirements skill writes it).`,
    );
  } else {
    const notMet = task.rows.filter((r) => !isMet(r));
    const label = (r: Row) => `#${r.id} ${r.kind.toUpperCase()}`;
    const mustNotMet = notMet.filter((r) => r.kind === "must");
    if (mustNotMet.length) {
      add(
        1,
        `Every MUST requirement must have Verdict \`met\` with Evidence. Not met or not filled ` +
          `in: ${list(mustNotMet.map(label))}. Work on them, re-run their Check, and update the ` +
          `Verdict and Evidence cells in ${file}.`,
      );
    }
    const met = task.rows.length - notMet.length;
    const ratio = met / task.rows.length;
    if (ratio < MIN_MET_RATIO) {
      add(
        3,
        `Only ${met}/${task.rows.length} requirements are \`met\` with evidence ` +
          `(${Math.round(ratio * 100)}%, need at least ${MIN_MET_RATIO * 100}% overall, SHOULD ` +
          `rows included). Not met or not filled in: ${list(notMet.map(label))}.`,
      );
    }
  }

  if (!task.base) {
    add(
      5,
      `${file} has no \`Base: <branch>, <commit>\` line, so the review scope cannot ` +
        `be checked. Add it (the commit the task started from).`,
    );
  } else {
    const unmapped = changedSince(c.roots, task.base)
      .filter((f) => !review.text.includes(f.file))
      .map((f) => f.file);
    if (unmapped.length) {
      add(
        4,
        `The \`## Review\` section does not mention ${unmapped.length} file(s) changed since ` +
          `${task.base}: ${list(unmapped)}. Map and review every changed file.`,
      );
    }
  }

  if (review.findings.length === 0) {
    if (!review.noFindings) {
      add(
        5,
        `The \`## Review\` section has no findings table (columns File:line and Status) and does ` +
          `not say \`No findings.\``,
      );
    }
    return problems.sort((x, y) => x.priority - y.priority);
  }
  const isFixed = (f: Finding) => f.status === "fixed" && hasRealCommit(f.fix, c.roots);
  const fixed = review.findings.filter(isFixed).length;
  const ratio = fixed / review.findings.length;
  if (ratio < MIN_FIXED_RATIO) {
    const open = review.findings
      .filter((f) => !isFixed(f))
      .map((f) => `#${f.id} ${f.where} (${f.status === "fixed" ? "fixed, but no existing commit hash in Fix" : f.status || "no status"})`);
    add(
      2,
      `Only ${fixed}/${review.findings.length} review findings are fixed with a real commit ` +
        `(${Math.round(ratio * 100)}%, need at least ${MIN_FIXED_RATIO * 100}%). Open: ` +
        `${list(open)}. Fix them (with a test that covers each), commit, put the commit hash in the Fix ` +
        `cell and set Status to \`fixed\` in ${file}.`,
    );
  }
  return problems.sort((x, y) => x.priority - y.priority);
}

// ------------------------------------------------------- task state

interface Snapshot {
  text: string; // facts, read from the file and git
  steps: string[]; // what to do next, most urgent first
}

/**
 * Where the task stands, rebuilt from the requirements file (which holds the review once it
 * was written, if the file was written since `reviewSince`) and git, never from the
 * conversation: it must hold after a compaction, a /reload or a resume.
 */
function snapshot(c: { requirementsFile: string; roots: Set<string>; reviewSince: number }): Snapshot {
  const task = parseTask(c.requirementsFile);
  const must = task.rows.filter((r) => r.kind === "must");
  const lines = [
    `Task state (read from the requirements file and git, not from memory):`,
    `- Requirements, ${c.requirementsFile}: ${task.rows.length} rows (${must.length} MUST, ` +
      `${task.rows.length - must.length} SHOULD)${task.base ? `, Base ${task.base}` : ""}.`,
  ];
  const steps: string[] = [];
  const reqLine = (r: Row) =>
    `#${r.id} ${r.kind.toUpperCase()}: ${clip(r.text, 140)}${r.check ? ` (Check: ${clip(r.check, 100)})` : ""}`;

  const review = task.review;
  if (!review || task.mtime < c.reviewSince) {
    lines.push(`- Review: not recorded yet, so no requirement is verified.`);
    if (must.length) {
      lines.push(`- MUST requirements to deliver:\n` + must.slice(0, 12).map((r) => `    ${reqLine(r)}`).join("\n"));
      if (must.length > 12) lines.push(`    ... (+${must.length - 12} more in the requirements file)`);
    }
    steps.push(
      `Deliver every MUST requirement (read the requirements file for the full rows), ` +
        `committing as you go.`,
    );
    steps.push(`When all are done, finish: the review gate then asks for the review of the whole task.`);
  } else {
    const unmet = task.rows.filter((r) => !isMet(r));
    const unmetMust = unmet.filter((r) => r.kind === "must");
    const fixed = review.findings.filter((f) => f.status === "fixed" && hasRealCommit(f.fix, c.roots));
    const open = review.findings.filter((f) => !fixed.includes(f));
    lines.push(
      `- Review, in the same file: ${task.rows.length - unmet.length}/${task.rows.length} ` +
        `requirements met, ${fixed.length}/${review.findings.length} findings fixed with a commit.`,
    );
    if (unmetMust.length) {
      lines.push(`- MUST requirements not met:\n` + unmetMust.slice(0, 8).map((r) => `    ${reqLine(r)}`).join("\n"));
      if (unmetMust.length > 8) lines.push(`    ... (+${unmetMust.length - 8} more)`);
      steps.push(`Make the unmet MUST requirements pass, re-run each Check, update Verdict and Evidence.`);
    }
    if (open.length) {
      lines.push(
        `- Findings not fixed:\n` +
          open.slice(0, 8).map((f) => `    #${f.id} ${f.where} (${f.status || "no status"})`).join("\n"),
      );
      if (open.length > 8) lines.push(`    ... (+${open.length - 8} more)`);
      steps.push(`Fix the open findings (with a test that covers each), commit, put the hash in the Fix cell.`);
    }
    const unmetShould = unmet.filter((r) => r.kind !== "must");
    if (!unmetMust.length && unmetShould.length && (task.rows.length - unmet.length) / task.rows.length < MIN_MET_RATIO) {
      steps.push(`Meet enough SHOULD requirements to reach ${MIN_MET_RATIO * 100}% overall.`);
    }
    if (task.base) {
      const unmapped = changedSince(c.roots, task.base).filter((f) => !review.text.includes(f.file));
      if (unmapped.length) steps.push(`Add the ${unmapped.length} changed file(s) missing from the Review section: ${list(unmapped.map((f) => f.file), 6)}.`);
    }
    if (!steps.length) steps.push(`Try to finish: the review bar looks met.`);
  }

  for (const root of c.roots) {
    const base = task.base;
    if (!base || git(root, ["cat-file", "-e", `${base}^{commit}`]) === undefined) continue;
    const commits = (git(root, ["rev-list", "--count", `${base}..HEAD`]) ?? "?").trim();
    const dirty = (git(root, ["status", "--porcelain"]) ?? "").split("\n").filter(Boolean);
    lines.push(
      `- Repo ${root}: ${commits} commit(s) since ${base}; ${dirty.length} uncommitted or untracked file(s)` +
        (dirty.length ? `: ${list(dirty.map((d) => d.slice(3)), 8)}` : "") +
        `.`,
    );
    if (dirty.length) steps.push(`Commit or remove the uncommitted files in ${root}.`);
  }
  return { text: lines.join("\n"), steps };
}

const numbered = (items: string[]) => items.map((p, i) => `${i + 1}. ${p}`).join("\n");

const MISSING_REQUIREMENTS =
  `The review gate cannot run: no task requirements file exists (${LOG_DIR}/<task>_requirements.md, ` +
  `written with the odoo-task-requirements skill). Do not review and do not keep working. ` +
  `End your final message by telling the human plainly that the task requirements file was ` +
  `missing, so the review gate did not run and the work has not been reviewed; then ` +
  `summarise what you did and what is still unverified.`;

// ------------------------------------------------------------ extension

export default function (pi: ExtensionAPI) {
  let seq = 0;
  let lastEdit = 0; // 0 = no code edited
  let requirementsTouched = false; // the agent wrote a requirements file
  let promptTime = 0; // when the last user prompt started
  let requestSeq = 0; // 0 = the review has not been requested yet
  let requestTime = 0;
  let skillSeq = 0; // last time odoo-review/SKILL.md was opened
  let nudges = 0; // only numbers the messages
  let missingReported = false;
  let lastAnyEdit = 0; // any edit/write call, whatever the file (the requirements file counts)
  let editSnapshot = -1; // lastAnyEdit at the previous gate run; -1 = no run yet
  let outbox: { content: string; isRequest: boolean } | undefined; // sent after a compaction
  let gateCompacting = false; // the compaction in progress was started by the gate
  let idleRuns = 0; // consecutive gate runs with no edit/write call in between
  const skillReads = new Map<string, number>(); // abs path of skill .md -> seq when opened
  const editedDirs = new Set<string>();

  const persist = () =>
    pi.appendEntry(STATE_ENTRY, {
      codeEdited: lastEdit > 0,
      requirementsTouched,
      editedDirs: [...editedDirs],
    });

  const resetReview = () => {
    requestSeq = requestTime = skillSeq = nudges = 0;
    missingReported = false;
    editSnapshot = -1;
    idleRuns = 0;
    outbox = undefined;
    gateCompacting = false;
  };
  pi.on("session_start", async (_event, ctx) => {
    seq = lastEdit = lastAnyEdit = 0;
    requirementsTouched = false;
    promptTime = 0;
    skillReads.clear();
    editedDirs.clear();
    resetReview();
    try {
      const saved = ctx.sessionManager
        .getBranch()
        .filter((e: any) => e.type === "custom" && e.customType === STATE_ENTRY)
        .at(-1) as { data?: { codeEdited?: boolean; requirementsTouched?: boolean; editedDirs?: string[] } } | undefined;
      if (saved?.data) {
        if (saved.data.codeEdited) lastEdit = ++seq;
        requirementsTouched = saved.data.requirementsTouched === true;
        for (const d of saved.data.editedDirs ?? []) editedDirs.add(d);
      }
    } catch {
      // a session without a readable branch simply starts with no remembered work
    }
  });
  pi.on("before_agent_start", async (event) => {
    if ((event as { messageType?: string }).messageType === "user") {
      resetReview();
      promptTime = Date.now();
    }
    return undefined;
  });

  const noteSkillRead = (abs: string) => {
    if (abs.startsWith(SKILLS_DIR + path.sep) && abs.endsWith(".md") && existsSync(abs)) {
      const n = ++seq;
      skillReads.set(abs, n);
      if (abs === REVIEW_SKILL_MD) skillSeq = n;
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const raw = inputPath(event.input as Record<string, unknown>);
      if (raw) {
        lastAnyEdit = ++seq;
        const abs = expand(raw, ctx.cwd);
        let changed = false;
        if (abs.startsWith(LOG_DIR + path.sep) && abs.endsWith("_requirements.md") && !requirementsTouched) {
          requirementsTouched = true;
          changed = true;
        }
        if (isCodeEdit(abs)) {
          if (lastEdit === 0) changed = true;
          lastEdit = ++seq;
          const dir = path.dirname(abs);
          if (!editedDirs.has(dir)) {
            editedDirs.add(dir);
            changed = true;
          }
        }
        if (changed) persist();
      }
    } else if (event.toolName === "read") {
      const raw = inputPath(event.input as Record<string, unknown>);
      if (raw) noteSkillRead(expand(raw, ctx.cwd));
    } else if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (/\b(cat|head|tail|sed|less|more|bat|nl)\b/.test(command)) {
        for (const m of command.matchAll(/(?:~|\$\{?HOME\}?|\/)[^\s'"|;&<>()`]*\.md/g)) {
          noteSkillRead(expand(m[0].replace(/^\$\{?HOME\}?/, "~"), ctx.cwd));
        }
      }
    }
    return undefined;
  });

  const inFlight = () => lastEdit > 0 || requirementsTouched;
  const reposEdited = () => {
    const roots = new Set<string>();
    for (const dir of editedDirs) {
      const root = repoRoot(dir);
      if (root) roots.add(root);
    }
    return roots;
  };

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!inFlight()) return undefined; // nothing started: questions and read-only work are never held
    if (event.outcome !== "completed") return undefined; // errors/aborts are hard exits (provider errors: auto-recover.ts)

    const requirementsFile = newestLogFileSince("_requirements.md", 0);
    if (!requirementsFile) {
      if (missingReported) return undefined; // already told the human: let the agent finish
      missingReported = true;
      ctx.ui?.notify?.(
        "require-review-gate: no task requirements file; the review gate did not run",
        "warning",
      );
      return {
        entries: [
          ...event.entries,
          { type: "custom_message", customType: "review-gate", content: MISSING_REQUIREMENTS, display: true },
        ],
        continue: true,
      };
    }

    const roots = reposEdited();
    const isRequest = requestSeq === 0;
    let problems: Problem[];
    if (isRequest) {
      problems = [{ priority: 0, text: reviewRequest(requirementsFile) }];
    } else {
      const reads = new Set<string>();
      for (const [abs, n] of skillReads) if (n > requestSeq) reads.add(path.basename(abs));
      problems = reviewProblems({
        requestTime,
        skillReadAfterRequest: skillSeq > requestSeq,
        guidelineReadsAfterRequest: reads,
        roots,
        requirementsFile,
      });
    }

    if (problems.length === 0) {
      nudges = 0;
      idleRuns = 0;
      return undefined;
    }

    if (editSnapshot >= 0 && lastAnyEdit === editSnapshot) idleRuns++;
    else idleRuns = 0;
    editSnapshot = lastAnyEdit;
    if (idleRuns >= MAX_IDLE_RUNS) {
      ctx.ui?.notify?.(
        `require-review-gate: letting the agent stop; the gate ran ${idleRuns + 1} times in a ` +
          `row and no file was edited in between. Open: ${problems.map((p) => p.text).join(" | ").slice(0, 400)}`,
        "warning",
      );
      return undefined;
    }
    nudges++;

    // Before the request, whatever review the file holds is from an earlier prompt: show none.
    const state = snapshot({
      requirementsFile,
      roots,
      reviewSince: isRequest ? Number.POSITIVE_INFINITY : requestTime,
    });
    const content = isRequest
      ? `Review gate: you are about to finish.\n\n${state.text}\n\n${problems[0].text}`
      : `Review gate: you are not done yet (check #${nudges}).\n\n${state.text}\n\n` +
        `Next steps, highest priority first:\n${numbered(problems.map((p) => p.text))}\n\n` +
        `Do not report completion until the review bar is met. If something blocks you, ` +
        `record it in the requirements file, try another approach, and keep working on the rest.`;
    outbox = { content, isRequest };
    return undefined;
  });

  pi.on("agent_settled", async (event, ctx) => {
    const msg = outbox;
    outbox = undefined;
    if (!msg || event.aborted) return;
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      if (msg.isRequest) {
        requestSeq = ++seq;
        requestTime = Date.now();
      }
      pi.sendMessage(
        { customType: "review-gate", content: msg.content, display: true },
        { triggerTurn: true },
      );
    };
    const usage = ctx.getContextUsage?.();
    if (usage?.tokens != null && usage.tokens < COMPACT_TOKENS) {
      send();
      return;
    }
    gateCompacting = true;
    try {
      ctx.compact({
        customInstructions: COMPACT_INSTRUCTIONS,
        onComplete: send,
        onError: (error: Error) => {
          if (!/nothing to compact|already compact/i.test(error.message)) {
            ctx.ui?.notify?.(`require-review-gate: compaction skipped (${error.message})`, "warning");
          }
          send();
        },
      });
    } catch {
      send();
    }
  });

  pi.on("session_compact_failed", async () => {
    gateCompacting = false;
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (gateCompacting) {
      gateCompacting = false; // the gate's own compaction: its message follows with the state
      return;
    }
    if (!inFlight()) return;
    const requirementsFile = newestLogFileSince("_requirements.md", 0);
    if (!requirementsFile) return;
    try {
      const state = snapshot({
        requirementsFile,
        roots: reposEdited(),
        reviewSince: requestTime || promptTime,
      });
      pi.sendMessage(
        {
          customType: "review-gate",
          content:
            `The context was compacted. Resume from the files, not from the summary.\n\n` +
            `${state.text}\n\nNext steps, highest priority first:\n${numbered(state.steps)}`,
          display: true,
        },
        ctx.isIdle() ? { triggerTurn: false } : { deliverAs: "steer" },
      );
    } catch {
      // the reminder is a courtesy; a broken requirements file must not break compaction
    }
  });
}
