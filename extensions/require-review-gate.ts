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
 *     hard-coded here), and write the report to `<log dir>/<task>_review.md` in the
 *     skill's report format. The findings go in a table the extension can read (File:line,
 *     Defect, Failure scenario, Fix, Guideline section or *judgement*, Status) and the
 *     skill's closing `Guidelines read:` line stays. The review must also check the work
 *     against the requirements file, so a requirement gap is a finding.
 *  2. Each later attempt to finish checks: the skill was read after the request, a report
 *     written after the request exists, it has the closing line, and at least 90% of its
 *     findings have Status `fixed`. Otherwise the agent goes back to fix the open
 *     findings, using the report it wrote, and updates their Status.
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

import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MIN_FIXED_RATIO = 0.9;
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

export interface Review {
  file: string;
  guidelinesRead: boolean;
  noFindings: boolean;
  findings: { id: string; where: string; status: string }[];
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

/** Parse the findings table (a "Status" column plus a "File" column) and the closing line. */
export function parseReview(file: string): Review {
  const text = readFileSync(file, "utf8");
  const review: Review = {
    file,
    guidelinesRead: /^\s*[*_]*guidelines read[*_]*\s*:[*_]*\s*\S+/im.test(text),
    noFindings: /\bno findings\b/i.test(text),
    findings: [],
  };
  let statusCol = -1;
  let whereCol = -1;
  let idCol = 0;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) {
      if (review.findings.length) break;
      statusCol = whereCol = -1;
      continue;
    }
    const c = cells(line);
    if (statusCol < 0) {
      const names = c.map(plain);
      const st = names.findIndex((n) => n === "status");
      const wh = names.findIndex((n) => n.includes("file"));
      if (st >= 0 && wh >= 0) {
        statusCol = st;
        whereCol = wh;
        idCol = Math.max(0, names.findIndex((n) => n === "#" || n === "id"));
      }
      continue;
    }
    if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue;
    if (!c[statusCol]) continue;
    review.findings.push({
      id: c[idCol] || String(review.findings.length + 1),
      where: c[whereCol] || "",
      status: plain(c[statusCol]),
    });
  }
  return review;
}

function reviewRequest(requirementsFile: string): string {
  return (
  `You are about to finish, so review your own work first (this is the last step):\n` +
  `   a. Load the review skill now: open ${REVIEW_SKILL_MD} with the read tool (even if you ` +
  `read it earlier) and follow ALL of its instructions strictly, every section and not only ` +
  `its numbered process, for the module you changed. Work from the skill itself, not from ` +
  `memory or from this message.\n` +
  `   b. Also check the work against the task requirements in ${requirementsFile}: a ` +
  `requirement that is missing, wrong or untested is a finding (section: *judgement*).\n` +
  `   c. Write the report to ${LOG_DIR}/<task>_review.md in the skill's report format. So ` +
  `that this gate can read it, put the findings in a table with exactly these columns ` +
  `(the skill's finding fields plus Status)\n` +
  `      | # | File:line | Defect | Failure scenario | Fix | Guideline section or *judgement* | Status |\n` +
  `      one row per finding (Status starts as \`open\`), and keep the skill's closing ` +
  `\`Guidelines read:\` line. With no findings, write \`No findings.\` instead of the table.\n` +
  `   d. Fix every finding you can (add the test that would have caught it, red first; ` +
  `commit), set its Status to \`fixed\` (commit or test in the Fix cell), and leave an ` +
  `ambiguous one as \`flagged\` with the reason in its Fix cell. At least ` +
  `${MIN_FIXED_RATIO * 100}% of the findings must be \`fixed\` before you may finish.`
  );
}

function reviewProblems(requestTime: number, skillReadAfterRequest: boolean): string[] {
  const problems: string[] = [];
  if (!skillReadAfterRequest) {
    problems.push(
      `The review skill was not loaded since the review was requested: open ` +
        `${REVIEW_SKILL_MD} with the read tool, then review per its Process.`,
    );
  }
  const file = newestLogFileSince("_review.md", requestTime);
  if (!file) {
    problems.push(
      `No review report written since the review was requested: write ` +
        `${LOG_DIR}/<task>_review.md (findings table + closing \`Guidelines read:\` line).`,
    );
    return problems;
  }
  const review = parseReview(file);
  if (!review.guidelinesRead) {
    problems.push(`${file} has no closing \`Guidelines read: <sections>\` line.`);
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
  const fixed = review.findings.filter((f) => f.status === "fixed").length;
  const ratio = fixed / review.findings.length;
  if (ratio < MIN_FIXED_RATIO) {
    const open = review.findings
      .filter((f) => f.status !== "fixed")
      .map((f) => `#${f.id} ${f.where} (${f.status || "no status"})`);
    problems.push(
      `Only ${fixed}/${review.findings.length} review findings are fixed ` +
        `(${Math.round(ratio * 100)}%, need at least ${MIN_FIXED_RATIO * 100}%). Open: ` +
        `${open.join("; ")}. Fix them (test red first), commit, and set Status to \`fixed\` ` +
        `in ${file}.`,
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

  const resetReview = () => {
    requestSeq = requestTime = skillSeq = nudges = 0;
    missingReported = false;
  };
  pi.on("session_start", () => {
    seq = lastEdit = 0;
    resetReview();
  });
  pi.on("before_agent_start", async (event) => {
    if ((event as { messageType?: string }).messageType === "user") resetReview();
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const raw = inputPath(event.input as Record<string, unknown>);
      if (raw && isCodeEdit(expand(raw, ctx.cwd))) lastEdit = ++seq;
    } else if (event.toolName === "read") {
      const raw = inputPath(event.input as Record<string, unknown>);
      if (raw && expand(raw, ctx.cwd) === REVIEW_SKILL_MD) skillSeq = ++seq;
    } else if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (
        /\b(cat|head|tail|sed|less|more|bat|nl)\b/.test(command) &&
        /odoo-review\/SKILL\.md/.test(command)
      ) {
        skillSeq = ++seq;
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
      problems = reviewProblems(requestTime, skillSeq > requestSeq);
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
