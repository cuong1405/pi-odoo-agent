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
 * One file is the single source of truth: `<log dir>/<task>_requirements.json`, which the agent
 * writes with the odoo-task-requirements skill. The `review` field records results, files,
 * guidelines read, and findings in the same document.
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
 *     - the requirements file was written after the request and has a completed `review` object;
 *     - the skill was read after the request, and every guideline file named in the
 *       `guidelinesRead` array was opened after the request (tracked from read/cat calls);
 *     - the file has a `base.commit`, and every file changed since it (committed,
 *       uncommitted, untracked, in the repos the agent edited) appears in `review.reviewedFiles`,
 *       so the review covers the whole task;
 *     - every MUST requirement has `passes: true` and non-empty evidence, and at least
 *       90% of all requirements pass (the 90% is the tolerance for a task text that
 *       is not 100% accurate, so it only ever forgives SHOULD rows);
 *     - at least 90% of the findings are `fixed` AND name a commit hash that exists in the
 *       repo and is reachable from HEAD.
 *     Otherwise the agent goes back to work on the open items.
 *
 * Every message that sends the agent back has two parts, both computed from the file and git:
 *  - Task state: requirements (MUST/SHOULD counts), the review if it was written (met count,
 *    each unmet MUST with its text and Check, open findings), and per repo the commits since
 *    `base.commit` and the uncommitted files.
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
 * A review with no findings has an empty `review.findings` array.
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
  "(<task>_requirements.json) with its Base commit, the numbers of the requirements still not " +
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
const REQUIREMENTS_SUFFIX = "_requirements.json";
const REQUIREMENTS_SCHEMA = path.join(SKILLS_DIR, "odoo-task-requirements", "requirements.schema.json");

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

interface Requirement {
  id: string;
  priority: "must" | "should";
  description: string;
  checks: string[];
}

interface Finding {
  id: string;
  file: string;
  location: string;
  status: "open" | "fixed" | "flagged";
  fixCommit: string | null;
}

interface Review {
  results: { id: string; passes: boolean; evidence: string }[];
  reviewedFiles: string[];
  guidelinesRead: string[];
  findings: Finding[];
}

interface Task {
  base: { commit: string };
  requirements: Requirement[];
  review: Review | null;
}

interface JsonSchema {
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  pattern?: string;
}

// Validate the keywords used by the shipped schema using Node built-ins.
function validate(value: unknown, schema: JsonSchema, root: JsonSchema, at = ""): void {
  const fail = (message: string): never => { throw new Error(`${at || "/"}: ${message}`); };
  if (schema.$ref) {
    const target = root.$defs?.[schema.$ref.replace(/^#\/\$defs\//, "")];
    if (!target) fail(`unknown schema reference ${schema.$ref}`);
    validate(value, target!, root, at);
    return;
  }
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && ![schema.type].flat().includes(kind)) {
    fail(`must be ${[schema.type].flat().join(" or ")}`);
  }
  if ("const" in schema && value !== schema.const) fail(`must equal ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    fail(`must match pattern ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) fail(`must have at least ${schema.minItems} entries`);
    const items = schema.items;
    if (items) value.forEach((entry, index) => validate(entry, items, root, `${at}/${index}`));
  } else if (kind === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(record, key)) fail(`missing required field "${key}"`);
    }
    const properties = schema.properties ?? {};
    for (const [key, entry] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) validate(entry, properties[key], root, `${at}/${key}`);
      else if (schema.additionalProperties === false) fail(`unknown field "${key}"`);
    }
  }
}

let requirementsSchema: JsonSchema | undefined;

function parseTask(file: string): { task: Task; mtime: number } {
  if (!requirementsSchema) {
    try {
      requirementsSchema = JSON.parse(readFileSync(REQUIREMENTS_SCHEMA, "utf8")) as JsonSchema;
    } catch (error) {
      throw new Error(`Cannot load the installed schema at ${REQUIREMENTS_SCHEMA}: ${errorMessage(error)}`);
    }
  }

  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  validate(data, requirementsSchema, requirementsSchema);
  const task = data as Task;
  const ids = new Set<string>();
  for (const requirement of task.requirements) {
    if (ids.has(requirement.id)) throw new Error(`Duplicate requirement ID: ${requirement.id}`);
    ids.add(requirement.id);
  }
  return { task, mtime: statSync(file).mtimeMs };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultIndex(review: Review) {
  return new Map(review.results.map((result) => [result.id, result]));
}

function isMet(result: Review["results"][number] | undefined): boolean {
  return result?.passes === true && result.evidence.trim().length > 0;
}

function newestRequirementsFile(): string | undefined {
  try {
    const files = readdirSync(LOG_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(REQUIREMENTS_SUFFIX))
      .map((entry) => path.join(LOG_DIR, entry.name));
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
    const tracked = git(root, ["diff", "--name-only", "-z", base, "--"]);
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (tracked === undefined || untracked === undefined) {
      throw new Error(`Cannot list changed files in ${root}`);
    }
    for (const f of new Set([...tracked.split("\0"), ...untracked.split("\0")])) {
      if (f) out.push({ root, file: f });
    }
  }
  return out;
}

/** A `fixed` finding must name a real commit that is reachable from HEAD. */
function hasRealCommit(sha: string | null, roots: Set<string>): boolean {
  return sha !== null && [...roots].some((root) =>
    git(root, ["cat-file", "-e", `${sha}^{commit}`]) !== undefined &&
    git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== undefined
  );
}

function missingReviewedFiles(review: Review, roots: Set<string>, base: string): string[] {
  const reviewed = new Set(review.reviewedFiles);
  return changedSince(roots, base).map(({ file }) => file).filter((file) => !reviewed.has(file));
}

// ------------------------------------------------------------ the review

function reviewRequest(requirementsFile: string): string {
  return (
    `You are about to finish, so review your own work first (this is the last step):\n` +
    `   a. Load the review skill now: open ${REVIEW_SKILL_MD} with the read tool (even if you ` +
    `read it earlier) and follow ALL of its instructions strictly, every section and not ` +
    `only its numbered process. Work from the skill itself, not from memory or from this ` +
    `message. Its sibling guideline files must be opened again for this review.\n` +
    `   b. Review the whole diff from base.commit in ${requirementsFile}, including uncommitted ` +
    `and untracked work. List exact repository-relative paths in review.reviewedFiles. To see ` +
    `Unicode paths, use git -c core.quotePath=false diff --name-only <base.commit> and ` +
    `git -c core.quotePath=false ls-files --others --exclude-standard.\n` +
    `   c. Run each requirement's checks now. In review.results, record one object per ID: ` +
    `{"id":"1","passes":true,"evidence":"command and observed result"}. Every MUST and at ` +
    `least ${MIN_MET_RATIO * 100}% of all requirements must pass with evidence.\n` +
    `   d. Replace only the review field in the same JSON file, following ${REQUIREMENTS_SCHEMA}. ` +
    `Record freshly opened skill-relative files in review.guidelinesRead, for example ` +
    `odoo-guidelines/guidelines/python.md. Use review.findings: [] when there are no findings. ` +
    `Treat weakened tests, relaxed thresholds, and requirement shortfalls as findings.\n` +
    `   e. Fix findings and commit. Set status to "fixed" with the reachable hash in fixCommit. ` +
    `Record the reason in fix for "flagged" findings. At least ${MIN_FIXED_RATIO * 100}% of ` +
    `findings must be fixed with a reachable commit.`
  );
}

interface ReviewContext {
  requestTime: number;
  skillReadAfterRequest: boolean;
  guidelineReadsAfterRequest: Set<string>; // paths relative to the skills directory opened after the request
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
  let parsed: ReturnType<typeof parseTask>;
  try {
    parsed = parseTask(file);
  } catch (error) {
    add(0, `Repair ${file} using the requirements schema. ${errorMessage(error)}`);
    return problems;
  }
  const { task, mtime } = parsed;
  const { review } = task;
  if (!review || mtime < c.requestTime) {
    add(0, `Record a fresh review in the review field of ${file}, using ${REQUIREMENTS_SCHEMA}.`);
  }

  if (!c.skillReadAfterRequest) {
    add(5, `Open ${REVIEW_SKILL_MD} with the read tool and follow it before submitting the review.`);
  }
  if (!review || mtime < c.requestTime) return problems;

  const unread = [...new Set(review.guidelinesRead)].filter((f) => !c.guidelineReadsAfterRequest.has(f));
  if (unread.length) {
    add(5, `review.guidelinesRead lists files not opened since the review request: ${list(unread)}.`);
  }

  const ids = new Set(task.requirements.map(({ id }) => id));
  const results = resultIndex(review);
  const missing = task.requirements.filter(({ id }) => !results.has(id)).map(({ id }) => id);
  const unknown = [...results.keys()].filter((id) => !ids.has(id));
  if (results.size !== review.results.length) add(0, "review.results has duplicate requirement IDs.");
  if (unknown.length) add(0, `review.results has unknown IDs: ${list(unknown)}.`);
  if (missing.length) add(0, `review.results is missing requirement IDs: ${list(missing)}.`);

  const notMet = task.requirements.filter(({ id }) => !isMet(results.get(id)));
  const label = (requirement: Requirement) => `#${requirement.id} ${requirement.priority.toUpperCase()}`;
  const unmetMust = notMet.filter(({ priority }) => priority === "must");
  if (unmetMust.length) {
    add(1, `Every MUST must pass with evidence. Re-run the checks for: ${list(unmetMust.map(label))}.`);
  }
  const met = task.requirements.length - notMet.length;
  if (met / task.requirements.length < MIN_MET_RATIO) {
    add(3, `Only ${met}/${task.requirements.length} requirements pass with evidence ` +
      `(need ${MIN_MET_RATIO * 100}%). Unmet: ${list(notMet.map(label))}.`);
  }

  const base = task.base.commit;
  if (c.roots.size && ![...c.roots].some((root) =>
    git(root, ["merge-base", "--is-ancestor", base, "HEAD"]) !== undefined
  )) {
    add(4, `base.commit ${base} is not an ancestor of HEAD in any edited repository.`);
  } else {
    try {
      const unmapped = missingReviewedFiles(review, c.roots, base);
      if (unmapped.length) {
        add(4, `review.reviewedFiles is missing ${unmapped.length} changed file(s): ${list(unmapped)}.`);
      }
    } catch (error) {
      add(4, errorMessage(error));
    }
  }

  if (new Set(review.findings.map(({ id }) => id)).size !== review.findings.length) {
    add(0, "review.findings has duplicate finding IDs.");
  }
  for (const [index, finding] of review.findings.entries()) {
    if (finding.status === "fixed" && finding.fixCommit === null) {
      add(0, `/review/findings/${index}/fixCommit: provide the commit hash for a fixed finding.`);
    } else if (finding.status !== "fixed" && finding.fixCommit !== null) {
      add(0, `/review/findings/${index}/fixCommit: set this to null for a ${finding.status} finding.`);
    }
  }
  const open = review.findings.filter((f) => f.status !== "fixed" || !hasRealCommit(f.fixCommit, c.roots));
  const fixed = review.findings.length - open.length;
  if (review.findings.length && fixed / review.findings.length < MIN_FIXED_RATIO) {
    const details = open.map((f) => `#${f.id} ${f.file}:${f.location} ` +
      `(${f.status === "fixed" ? "unreachable or missing fixCommit" : f.status})`);
    add(2, `Only ${fixed}/${review.findings.length} findings are fixed with a reachable commit ` +
      `(need ${MIN_FIXED_RATIO * 100}%). Open: ${list(details)}.`);
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
  let parsed: ReturnType<typeof parseTask>;
  try {
    parsed = parseTask(c.requirementsFile);
  } catch (error) {
    return {
      text: `Requirements file could not be read: ${errorMessage(error)}`,
      steps: [`Repair ${c.requirementsFile} using ${REQUIREMENTS_SCHEMA}.`],
    };
  }
  const { task, mtime } = parsed;
  const must = task.requirements.filter(({ priority }) => priority === "must");
  const lines = [
    "Task state (read from the requirements file and git):",
    `- ${c.requirementsFile}: ${task.requirements.length} requirements (${must.length} MUST, ` +
      `${task.requirements.length - must.length} SHOULD), base ${task.base.commit}.`,
  ];
  const steps: string[] = [];
  const reqLine = (requirement: Requirement) =>
    `#${requirement.id} ${requirement.priority.toUpperCase()}: ${clip(requirement.description, 140)} ` +
    `(Checks: ${clip(requirement.checks.join("; "), 100)})`;

  const { review } = task;
  if (!review || mtime < c.reviewSince) {
    lines.push("- Review: pending fresh verification.");
    if (must.length) lines.push(`- MUST requirements: ${list(must.map(reqLine), 12)}.`);
    steps.push("Deliver all MUST requirements and commit as you go.");
    steps.push("At completion the gate requests a fresh review.");
  } else {
    const results = resultIndex(review);
    const unmet = task.requirements.filter(({ id }) => !isMet(results.get(id)));
    const unmetMust = unmet.filter(({ priority }) => priority === "must");
    const open = review.findings.filter((f) => f.status !== "fixed" || !hasRealCommit(f.fixCommit, c.roots));
    lines.push(
      `- Review: ${task.requirements.length - unmet.length}/${task.requirements.length} requirements passed, ` +
        `${review.findings.length - open.length}/${review.findings.length} findings fixed with a commit.`,
    );
    if (unmetMust.length) {
      lines.push(`- Unmet MUST requirements: ${list(unmetMust.map(reqLine), 8)}.`);
      steps.push("Resolve the unmet MUST requirements, re-run their checks, and update review.results.");
    }
    if (open.length) {
      lines.push(`- Findings still open: ${list(open.map((f) => `#${f.id} ${f.file}:${f.location} (${f.status})`), 8)}.`);
      steps.push("Fix and commit open findings and record their fixCommit hashes.");
    }
    if (!unmetMust.length && (task.requirements.length - unmet.length) / task.requirements.length < MIN_MET_RATIO) {
      steps.push(`Meet enough SHOULD requirements to reach ${MIN_MET_RATIO * 100}% overall.`);
    }
    try {
      const unmapped = missingReviewedFiles(review, c.roots, task.base.commit);
      if (unmapped.length) steps.push(`Add the changed files missing from review.reviewedFiles: ${list(unmapped, 6)}.`);
    } catch (error) {
      steps.push(errorMessage(error));
    }
    if (!steps.length) steps.push("Try to finish so the gate can check the recorded review.");
  }

  for (const root of c.roots) {
    const base = task.base.commit;
    if (git(root, ["cat-file", "-e", `${base}^{commit}`]) === undefined) continue;
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
  `The review gate cannot run: no task requirements file exists (${LOG_DIR}/<task>_requirements.json, ` +
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
        if (abs.startsWith(LOG_DIR + path.sep) && abs.endsWith(REQUIREMENTS_SUFFIX) && !requirementsTouched) {
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

    const requirementsFile = newestRequirementsFile();
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
      for (const [abs, n] of skillReads) if (n > requestSeq) reads.add(path.relative(SKILLS_DIR, abs));
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
    const requirementsFile = newestRequirementsFile();
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
