/**
 * require-review-gate: the agent may not finish until it has reviewed its own work with
 * the odoo-review skill and fixed at least 90% of what that review found.
 *
 * Why: in a long autonomous session nobody reviews between rounds, and an agent that is
 * tired of the task simply says "done". Prose in AGENTS.md cannot stop that. This
 * extension holds the turn open at the point where the agent tries to stop:
 *
 *  0. Requirements file: the review is measured against `<log dir>/<task>_requirements.md`,
 *     which the agent writes with the odoo-task-requirements skill (the human chooses per
 *     task whether to invoke it). The extension never parses the file; it only needs one to
 *     exist. If none exists when the agent tries to finish, the gate does not run: the agent
 *     is sent back once, only to tell the human in its final message that the requirements
 *     file was missing and the work was not reviewed, then it may finish.
 *  1. When the agent tries to finish (after it edited code in this session), it is sent
 *     to review its own work: load the odoo-review skill NOW (a fresh read of its SKILL.md
 *     after this request, even if it was read earlier and nothing was compacted), follow
 *     ALL of that skill's instructions strictly (nothing of the skill is restated or
 *     hard-coded here), and write the report to `<log dir>/<task>_review.md`.
 *  2. Each later attempt to finish is checked against facts the extension can verify,
 *     because the agent writes the report itself and cannot be trusted to grade itself:
 *     - the skill was read after the request, and every guideline file named on the
 *       `Guidelines read:` line was opened after the request (tracked from read/cat calls);
 *     - the requirements file (odoo-task-requirements format) has a `Base:` commit, and every
 *       file changed since it (committed, uncommitted, untracked, in the repos the agent
 *       edited) appears in the report, so the review covers the whole task;
 *     - the report has a verdict table with one row per numbered requirement: every MUST
 *       row is `met` with non-empty evidence, and at least 90% of all rows are (the 90% is the
 *       tolerance for a task text that is not 100% accurate, so it only ever forgives
 *       SHOULD rows);
 *     - at least 90% of the findings are `fixed` AND name a commit hash that exists in the
 *       repo and is reachable from HEAD (a finding with no real commit is not fixed).
 *     Otherwise the agent goes back to fix the open items and update the report.
 *
 * The report is a file (not conversation text) so the extension can check its time and
 * format, and the agent can re-read it after a compaction. A review with no findings says
 * `No findings.` instead of the table.
 *
 * There is deliberately NO retry cap and no escape hatch: the agent keeps working until the
 * bar is met, and the human interrupts the session if it is stuck. Each nudge is shown in
 * the session (display: true). A new user prompt starts the review stage again, and
 * everything resets on `session_start`. The gate applies only once the agent has edited
 * code, so questions and read-only work are never held.
 *
 * Install: copy to ~/.pi/agent/extensions/require-review-gate.ts and run /reload.
 * Env: ODOO_LOG_DIR overrides the report directory (default ~/src/odoo/log);
 *      PI_SKILLS_DIR overrides the skills directory (default ~/.pi/agent/skills).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MIN_FIXED_RATIO = 0.9;
const MIN_MET_RATIO = 0.9;
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

/** Files that are not "the work": logs and reports, scratch, installed skills. */
function isCodeEdit(abs: string): boolean {
  if (abs.startsWith(LOG_DIR + path.sep)) return false;
  if (abs.startsWith(SKILLS_DIR + path.sep)) return false;
  if (abs.startsWith("/tmp/")) return false;
  return true;
}

// ---------------------------------------------------------------- report

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

export interface Requirements {
  file: string;
  base?: string;
  rows: { id: string; kind: string }[];
}

/** Rows of the requirements table (numbered, MUST/SHOULD) and the `Base:` commit. */
export function parseRequirements(file: string): Requirements {
  const text = readFileSync(file, "utf8");
  const baseLine = text.match(/^\s*[*_]*base[*_]*\s*:\s*(.+)$/im)?.[1] ?? "";
  const out: Requirements = {
    file,
    base: baseLine.match(/\b[0-9a-f]{7,40}\b/)?.[0],
    rows: [],
  };
  for (const t of parseTables(text)) {
    const kind = colOf(t, (n) => n.includes("must"));
    const req = colOf(t, (n) => n.includes("requirement"));
    if (kind < 0 || req < 0) continue;
    for (const r of t.rows) {
      if (!/^\d+$/.test(plain(r[0] ?? ""))) continue;
      if (/superseded/i.test(r.join(" "))) continue;
      out.rows.push({ id: plain(r[0]), kind: plain(r[kind] ?? "") });
    }
  }
  return out;
}

export interface Review {
  file: string;
  text: string;
  guidelinesLine: string;
  noFindings: boolean;
  findings: { id: string; where: string; fix: string; status: string }[];
  verdicts: Map<string, { verdict: string; evidence: string }>;
}

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

/** Parse the findings table, the requirements-check table and the `Guidelines read:` line. */
export function parseReview(file: string): Review {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const gi = lines.findIndex((l) => /^\s*[*_]*guidelines read[*_]*\s*:/i.test(l));
  let guidelinesLine = "";
  if (gi >= 0) {
    for (let i = gi; i < lines.length && (i === gi || lines[i].trim() !== ""); i++) {
      guidelinesLine += " " + lines[i];
    }
    guidelinesLine = guidelinesLine.replace(/^\s*[*_]*guidelines read[*_]*\s*:[*_]*/i, "").trim();
  }
  const review: Review = {
    file,
    text,
    guidelinesLine,
    noFindings: /\bno findings\b/i.test(text),
    findings: [],
    verdicts: new Map(),
  };
  for (const t of parseTables(text)) {
    const st = colOf(t, (n) => n === "status");
    const wh = colOf(t, (n) => n.includes("file"));
    const vd = colOf(t, (n) => n === "verdict");
    const ev = colOf(t, (n) => n.includes("evidence"));
    const fx = colOf(t, (n) => n === "fix");
    const id = Math.max(0, colOf(t, (n) => n === "#" || n === "id"));
    if (st >= 0 && wh >= 0) {
      for (const r of t.rows) {
        if (!r[st]) continue;
        review.findings.push({
          id: r[id] || String(review.findings.length + 1),
          where: r[wh] || "",
          fix: fx >= 0 ? r[fx] || "" : "",
          status: plain(r[st]),
        });
      }
    } else if (vd >= 0) {
      for (const r of t.rows) {
        review.verdicts.set(plain(r[id] ?? ""), {
          verdict: plain(r[vd] ?? ""),
          evidence: (ev >= 0 ? r[ev] : "") ?? "",
        });
      }
    }
  }
  return review;
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
    `plus uncommitted and untracked files. Every changed file must appear in your report ` +
    `(the skill's Map step).\n` +
    `   c. Check every requirement in ${requirementsFile}. Run its Check yourself now; do not ` +
    `mark anything met from memory or from an earlier run. In the report, a table with one ` +
    `row per requirement number:\n` +
    `      | # | Verdict | Evidence |\n` +
    `      Verdict is \`met\` or \`not met\`. Evidence is what you ran or read for this ` +
    `review (command and result line, test name, log line, PNG path), never a claim. Every ` +
    `MUST requirement must be \`met\`, and at least ${MIN_MET_RATIO * 100}% of all ` +
    `requirements (SHOULD included).\n` +
    `   d. Findings, in the skill's report format, as a table with exactly these columns ` +
    `(the skill's finding fields plus Status)\n` +
    `      | # | File:line | Defect | Failure scenario | Fix | Guideline section or *judgement* | Status |\n` +
    `      A finding is a defect in the code or a gap against a requirement, not a ` +
    `description of what you changed. A weakened test, relaxed threshold or shortfall against ` +
    `a requirement is a finding even if you believe it is justified. Status starts as ` +
    `\`open\`. With no findings, write \`No findings.\` instead of the table.\n` +
    `   e. Keep the skill's closing \`Guidelines read:\` line, listing the guideline files you ` +
    `opened for this review (for example odoo-guidelines/python.md); each must have been ` +
    `opened after this request.\n` +
    `   f. Write the report to ${LOG_DIR}/<task>_review.md. Fix every finding you can (add the ` +
    `test that would have caught it, red first) and commit; set Status to \`fixed\` and put ` +
    `the commit hash in the Fix cell. Leave an ambiguous one \`flagged\` with the reason in ` +
    `its Fix cell. At least ${MIN_FIXED_RATIO * 100}% of the findings must be \`fixed\` with ` +
    `a commit that exists in the repository.`
  );
}

interface ReviewContext {
  requestTime: number;
  skillReadAfterRequest: boolean;
  guidelineReadsAfterRequest: Set<string>; // basenames of skill .md files opened after the request
  roots: Set<string>;
  requirementsFile: string;
}

function list(items: string[], cap = 25): string {
  return items.slice(0, cap).join("; ") + (items.length > cap ? `; ... (+${items.length - cap} more)` : "");
}

function reviewProblems(c: ReviewContext): string[] {
  const problems: string[] = [];
  if (!c.skillReadAfterRequest) {
    problems.push(
      `The review skill was not loaded since the review was requested: open ` +
        `${REVIEW_SKILL_MD} with the read tool, then review per all of its instructions.`,
    );
  }
  const file = newestLogFileSince("_review.md", c.requestTime);
  if (!file) {
    problems.push(
      `No review report written since the review was requested: write ` +
        `${LOG_DIR}/<task>_review.md (requirements table, findings table, closing ` +
        `\`Guidelines read:\` line).`,
    );
    return problems;
  }
  const review = parseReview(file);

  const claimed = [...new Set(review.guidelinesLine.match(/[\w.-]+\.md\b/g) ?? [])];
  if (!review.guidelinesLine) {
    problems.push(`${file} has no closing \`Guidelines read: <files>\` line.`);
  } else if (claimed.length === 0) {
    problems.push(
      `The \`Guidelines read:\` line names no guideline file (for example odoo-guidelines/python.md).`,
    );
  } else {
    const unread = claimed.filter((f) => !c.guidelineReadsAfterRequest.has(f));
    if (unread.length) {
      problems.push(
        `\`Guidelines read:\` names files you did not open since the review was requested: ` +
          `${unread.join(", ")}. Open them now (the skill requires reading them fresh for every ` +
          `review) or remove them from the line.`,
      );
    }
  }

  const req = parseRequirements(c.requirementsFile);
  if (req.rows.length === 0) {
    problems.push(
      `${c.requirementsFile} has no numbered requirement rows (table with # | Requirement | ` +
        `MUST/SHOULD columns, as the odoo-task-requirements skill writes it).`,
    );
  } else {
    const notMet = req.rows.filter((r) => {
      const v = review.verdicts.get(r.id);
      return !(v && v.verdict === "met" && v.evidence.trim().length > 0);
    });
    const label = (r: { id: string; kind: string }) => `#${r.id} ${r.kind.toUpperCase()}`;
    const mustNotMet = notMet.filter((r) => r.kind === "must");
    if (mustNotMet.length) {
      problems.push(
        `Every MUST requirement must be \`met\` with evidence. Not met or missing from the ` +
          `report's requirements table: ${list(mustNotMet.map(label))}. Work on them, re-run ` +
          `their Check, and update the table in ${file}.`,
      );
    }
    const met = req.rows.length - notMet.length;
    const ratio = met / req.rows.length;
    if (ratio < MIN_MET_RATIO) {
      problems.push(
        `Only ${met}/${req.rows.length} requirements are \`met\` with evidence ` +
          `(${Math.round(ratio * 100)}%, need at least ${MIN_MET_RATIO * 100}% overall, SHOULD ` +
          `rows included). Not met or missing: ${list(notMet.map(label))}.`,
      );
    }
  }

  if (!req.base) {
    problems.push(
      `${c.requirementsFile} has no \`Base: <branch>, <commit>\` line, so the review scope cannot ` +
        `be checked. Add it (the commit the task started from).`,
    );
  } else {
    const changed = changedSince(c.roots, req.base);
    const unmapped = changed.filter((f) => !review.text.includes(f.file)).map((f) => f.file);
    if (unmapped.length) {
      problems.push(
        `The report does not mention ${unmapped.length} file(s) changed since ${req.base}: ` +
          `${list(unmapped)}. Map and review every changed file.`,
      );
    }
  }

  if (review.findings.length === 0) {
    if (!review.noFindings) {
      problems.push(
        `${file} has no findings table (columns File:line and Status) and does not say ` +
          `\`No findings.\``,
      );
    }
    return problems;
  }
  const isFixed = (f: Review["findings"][number]) =>
    f.status === "fixed" && hasRealCommit(f.fix, c.roots);
  const fixed = review.findings.filter(isFixed).length;
  const ratio = fixed / review.findings.length;
  if (ratio < MIN_FIXED_RATIO) {
    const open = review.findings
      .filter((f) => !isFixed(f))
      .map((f) => `#${f.id} ${f.where} (${f.status === "fixed" ? "fixed, but no existing commit hash in Fix" : f.status || "no status"})`);
    problems.push(
      `Only ${fixed}/${review.findings.length} review findings are fixed with a real commit ` +
        `(${Math.round(ratio * 100)}%, need at least ${MIN_FIXED_RATIO * 100}%). Open: ` +
        `${list(open)}. Fix them (test red first), commit, put the commit hash in the Fix ` +
        `cell and set Status to \`fixed\` in ${file}.`,
    );
  }
  return problems;
}

const MISSING_REQUIREMENTS =
  `The review gate cannot run: no task requirements file exists (${LOG_DIR}/<task>_requirements.md, ` +
  `written with the odoo-task-requirements skill). Do not review and do not keep working. ` +
  `End your final message by telling the human plainly that the task requirements file was ` +
  `missing, so the review gate did not run and the work has not been reviewed; then ` +
  `summarise what you did and what is still unverified.`;

// ------------------------------------------------------------ extension

export default function (pi: ExtensionAPI) {
  let seq = 0;
  let lastEdit = 0;
  let requestSeq = 0; // 0 = the review has not been requested yet
  let requestTime = 0;
  let skillSeq = 0; // last time odoo-review/SKILL.md was opened
  let nudges = 0; // only numbers the messages
  let missingReported = false;
  const skillReads = new Map<string, number>(); // abs path of skill .md -> seq when opened
  const editedDirs = new Set<string>();

  const resetReview = () => {
    requestSeq = requestTime = skillSeq = nudges = 0;
    missingReported = false;
  };
  pi.on("session_start", () => {
    seq = lastEdit = 0;
    skillReads.clear();
    editedDirs.clear();
    resetReview();
  });
  pi.on("before_agent_start", async (event) => {
    if ((event as { messageType?: string }).messageType === "user") resetReview();
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
        const abs = expand(raw, ctx.cwd);
        if (isCodeEdit(abs)) {
          lastEdit = ++seq;
          editedDirs.add(path.dirname(abs));
        }
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

  pi.on("agent_before_settle", async (event, ctx) => {
    if (lastEdit === 0) return undefined; // no code touched: nothing to gate
    if (event.outcome !== "completed") return undefined; // errors/aborts are hard exits

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

    let problems: string[];
    if (requestSeq === 0) {
      requestSeq = ++seq;
      requestTime = Date.now();
      problems = [reviewRequest(requirementsFile)];
    } else {
      const roots = new Set<string>();
      for (const dir of editedDirs) {
        const root = repoRoot(dir);
        if (root) roots.add(root);
      }
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
      return undefined;
    }
    nudges++;

    const content =
      `You are not done yet (check #${nudges}):\n` +
      problems.map((p, i) => `${i + 1}. ${p}`).join("\n") +
      `\nDo not report completion until the review bar is met. If something blocks you, ` +
      `record it in the report, try another approach, and keep working on the rest.`;
    return {
      entries: [
        ...event.entries,
        { type: "custom_message", customType: "review-gate", content, display: true },
      ],
      continue: true,
    };
  });
}
