import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-review-gate-test-"));
const skills = path.join(workspace, "skills");
const logs = path.join(workspace, "log");
const repo = path.join(workspace, "repo");
const guideline = "odoo-guidelines/guidelines/python.md";
const reviewSkill = path.join(skills, "odoo-review", "SKILL.md");
const filename = "ảnh trong menu.webp";
const contract = path.join(logs, "fixture_requirements.json");

for (const file of [reviewSkill, path.join(skills, guideline)]) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "test skill");
}
mkdirSync(path.join(skills, "odoo-task-requirements"));
mkdirSync(logs);
mkdirSync(repo);
const schema = new URL("../skills/odoo-task-requirements/requirements.schema.json", import.meta.url);
writeFileSync(path.join(skills, "odoo-task-requirements/requirements.schema.json"), readFileSync(schema));
after(() => rmSync(workspace, { recursive: true, force: true }));

process.env.ODOO_LOG_DIR = logs;
process.env.PI_SKILLS_DIR = skills;
const { default: installGate } = await import("../extensions/require-review-gate.ts");

function git(...args) {
  return execFileSync("git", [
    "-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8" }).trim();
}

git("init", "-q", "-b", "main");
git("commit", "--allow-empty", "-qm", "Base");
const base = git("rev-parse", "HEAD");
git("switch", "-qc", "unmerged");
git("commit", "--allow-empty", "-qm", "Unmerged review fix");
const unmerged = git("rev-parse", "HEAD");
git("switch", "-q", "main");
writeFileSync(path.join(repo, filename), "placeholder");
git("add", filename);
git("commit", "-qm", "Add file");
const head = git("rev-parse", "HEAD");
writeFileSync(path.join(repo, "untracked.txt"), "another changed file");

function planning() {
  const planningFixture = new URL("../skills/odoo-task-requirements/requirements.example.json", import.meta.url);
  const task = JSON.parse(readFileSync(planningFixture, "utf8"));
  task.base.commit = base;
  return task;
}

function completedReview(ids = ["1"]) {
  return {
    results: ids.map((id) => ({ id, passes: true, evidence: "check | filtered output\n2 passed" })),
    reviewedFiles: [filename, "untracked.txt"],
    guidelinesRead: [guideline],
    findings: [],
  };
}

function finding(fixCommit = head) {
  return {
    id: "F1", file: filename, location: "1", defect: "Wrong image",
    scenario: "Load the page", fix: "Use the expected image", guideline: "judgement",
    status: "fixed", fixCommit,
  };
}

async function harness({ codeEdited = true } = {}) {
  const events = new Map();
  const messages = [];
  const ctx = {
    cwd: repo,
    getContextUsage: () => ({ tokens: 0 }),
    isIdle: () => false,
    sessionManager: {
      getBranch: () => [{
        type: "custom",
        customType: "review-gate-state",
        data: { codeEdited, editedDirs: codeEdited ? [repo] : [] },
      }],
    },
  };

  // Exercise the real Pi hook handlers with a controlled event source.
  installGate({
    on: (event, callback) => events.set(event, callback),
    appendEntry: () => {},
    sendMessage: (message) => messages.push(message.content),
  });
  const event = (name, data = {}) => events.get(name)(data, ctx);
  const now = new Date();
  async function finish() {
    messages.length = 0;
    await event("agent_before_settle", { outcome: "completed", entries: [] });
    await event("agent_settled", { aborted: false });
    return messages[0];
  }
  const write = async (content) => {
    await event("tool_call", { toolName: "write", input: { path: contract } });
    writeFileSync(contract, typeof content === "string" ? content : JSON.stringify(content));
    // Simulate a completed tool write on filesystems with coarse timestamp resolution.
    const timestamp = new Date(Math.max(Date.now(), now.getTime()) + 1000);
    utimesSync(contract, timestamp, timestamp);
  };
  const read = async (...files) => {
    for (const file of files) await event("tool_call", { toolName: "read", input: { path: file } });
  };
  await event("session_start");
  await event("before_agent_start", { messageType: "user" });
  return { event, finish, write, read, messages };
}

async function requestReview(task = planning()) {
  const agent = await harness();
  await agent.write(task);
  assert.match(await agent.finish(), /about to finish/);
  await agent.read(reviewSkill, path.join(skills, guideline));
  return agent;
}

test("the new JSON filename activates the gate without a code edit", async () => {
  const agent = await harness({ codeEdited: false });
  assert.equal(await agent.finish(), undefined);
  await agent.write(planning());
  assert.match(await agent.finish(), /Review: pending fresh verification/);
});

test("passes valid JSON with multiline evidence, a literal pipe, and Unicode and untracked paths", async () => {
  const task = planning();
  const agent = await requestReview(task);
  task.review = completedReview();
  await agent.write(task);
  assert.equal(await agent.finish(), undefined);
});

test("an invalid payload yields its JSON pointer and can be repaired in the same turn", async () => {
  const task = planning();
  const agent = await requestReview(task);
  await agent.write("");
  assert.match(await agent.finish(), /Repair .*fixture_requirements\.json/);
  task.review = completedReview();
  task.review.results[0].passes = "true";
  await agent.write(task);
  assert.match(await agent.finish(), /\/review\/results\/0\/passes: must be boolean/);
  task.review.results[0].passes = true;
  await agent.write(task);
  assert.equal(await agent.finish(), undefined);
});

test("a review written before the request is stale and compaction still shows the pending task", async () => {
  const task = planning();
  task.review = completedReview();
  const agent = await requestReview(task);
  const old = new Date(0);
  utimesSync(contract, old, old);
  assert.match(await agent.finish(), /Record a fresh review/);
  agent.messages.length = 0;
  await agent.event("session_compact");
  assert.match(agent.messages[0], /Review: pending fresh verification/);
});

test("checks exact changed paths and freshly opened guideline paths", async () => {
  const task = planning();
  const agent = await requestReview(task);
  task.review = completedReview();
  task.review.reviewedFiles[0] = `prefix/${filename}`;
  task.review.guidelinesRead = ["other-skill/guidelines/python.md"];
  await agent.write(task);
  const message = await agent.finish();
  assert.match(message, /missing 1 changed file\(s\): ảnh trong menu\.webp/);
  assert.match(message, /files not opened since the review request: other-skill\/guidelines\/python\.md/);
});

test("rejects duplicate, missing and unknown result IDs", async () => {
  const task = planning();
  const agent = await requestReview(task);
  task.review = completedReview(["2", "2"]);
  await agent.write(task);
  const message = await agent.finish();
  assert.match(message, /duplicate requirement IDs/);
  assert.match(message, /unknown IDs: 2/);
  assert.match(message, /missing requirement IDs: 1/);
});

test("requires all MUST results and at least 90% overall", async () => {
  const task = planning();
  const template = task.requirements[0];
  task.requirements = Array.from({ length: 10 }, (_, i) => ({
    ...template, id: String(i + 1), priority: i === 0 ? "must" : "should",
  }));
  const agent = await requestReview(task);
  task.review = completedReview(task.requirements.map(({ id }) => id));
  task.review.results[0].passes = false;
  await agent.write(task);
  assert.match(await agent.finish(), /Every MUST must pass/);
  task.review.results[0].passes = true;
  task.review.results[1].passes = task.review.results[2].passes = false;
  await agent.write(task);
  assert.match(await agent.finish(), /Only 8\/10/);
  task.review.results[1].passes = true;
  await agent.write(task);
  assert.equal(await agent.finish(), undefined);
});

test("a fixed finding needs a reachable commit", async () => {
  const task = planning();
  const agent = await requestReview(task);
  task.review = completedReview();
  task.review.findings = [finding(null)];
  await agent.write(task);
  assert.match(await agent.finish(), /\/review\/findings\/0\/fixCommit/);
  task.review.findings = [finding(unmerged)];
  await agent.write(task);
  assert.match(await agent.finish(), /unreachable or missing fixCommit/);
  task.review.findings = [finding()];
  await agent.write(task);
  assert.equal(await agent.finish(), undefined);
});

test("the finding threshold accepts 90% fixed and rejects 80%", async () => {
  const task = planning();
  const agent = await requestReview(task);
  task.review = completedReview();
  task.review.findings = Array.from({ length: 10 }, (_, i) => ({
    ...finding(), id: `F${i + 1}`,
  }));
  for (const index of [8, 9]) {
    Object.assign(task.review.findings[index], { status: "open", fixCommit: null });
  }
  await agent.write(task);
  assert.match(await agent.finish(), /Only 8\/10 findings/);
  Object.assign(task.review.findings[8], { status: "fixed", fixCommit: head });
  await agent.write(task);
  assert.equal(await agent.finish(), undefined);
});
