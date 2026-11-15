/**
 * require-skill-reads: make the agent actually READ the Odoo skill guidelines.
 *
 * Why: Pi only advertises a skill's name and description; the model must open the files
 * itself and often does not (and `SKILL.md` is only an index, the rules live in
 * `guidelines/*.md`). Prose in AGENTS.md cannot force that, so this extension does.
 *
 * Behaviour:
 *  - Records every successful `read` of a file under the skills directory.
 *  - Before an `edit` / `write` of an addon file, checks that the guideline files matching
 *    that file type were read in this session; if not, blocks the call and names the exact
 *    files to read. The agent reads them and repeats the edit.
 *  - Forgets everything on `session_compact` and `session_start`, so the guidelines must be
 *    read again after the context is summarised or the session is resumed.
 *  - Fails open: a required file that does not exist on disk is not required, and after
 *    MAX_BLOCKS blocks on the same file the edit is let through (with a notification), so a
 *    broken skills install can never deadlock an autonomous loop.
 *
 * Install: copy to ~/.pi/agent/extensions/require-skill-reads.ts and run /reload.
 * Override the skills directory with PI_SKILLS_DIR (default ~/.pi/agent/skills).
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_BLOCKS = 3;
const SKILLS_DIR = path.resolve(
  process.env.PI_SKILLS_DIR || path.join(os.homedir(), ".pi", "agent", "skills"),
);

const GUIDE = "odoo-guidelines";
const WEB = "odoo-web-guidelines";

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

/** Skill files (relative to SKILLS_DIR) that must have been read before touching `abs`. */
function requiredFor(abs: string): string[] {
  const segs = abs.split(path.sep);
  const base = path.basename(abs);
  const ext = path.extname(abs).toLowerCase();
  const has = (...names: string[]) => names.some((n) => segs.includes(n));
  const need: string[] = [];
  const guide = (file: string) => need.push(`${GUIDE}/guidelines/${file}`);
  const web = (file: string) => need.push(`${WEB}/guidelines/${file}`);

  const staticIdx = segs.lastIndexOf("static");
  if (staticIdx >= 0) {
    // Only static/src and static/tests are code; static/lib, description, img are not ours.
    if (!["src", "tests"].includes(segs[staticIdx + 1] ?? "")) return [];
    if ([".js", ".ts", ".xml"].includes(ext)) {
      need.push(`${WEB}/SKILL.md`);
      web("javascript.md");
    } else if ([".scss", ".css"].includes(ext)) {
      need.push(`${WEB}/SKILL.md`);
      web("scss.md");
    }
    return need;
  }

  if (ext === ".py") {
    need.push(`${GUIDE}/SKILL.md`);
    guide("python.md");
    if (base === "__manifest__.py") guide("manifest.md");
    if (has("tests") || base.startsWith("test_")) guide("tests.md");
    if (has("models", "wizard", "wizards")) {
      guide("orm.md");
      guide("fields.md");
    }
    if (has("controllers")) guide("controllers.md");
    if (has("report", "reports")) guide("reports.md");
  } else if (ext === ".xml") {
    need.push(`${GUIDE}/SKILL.md`);
    guide("xml.md");
    if (has("security")) guide("security.md");
    if (has("report", "reports")) guide("reports.md");
  } else if (ext === ".csv") {
    need.push(`${GUIDE}/SKILL.md`);
    guide(has("security") ? "security.md" : "xml.md");
  }
  return need;
}

function inputPath(input: Record<string, unknown>): string | undefined {
  const raw = input.path ?? input.file_path ?? input.filePath;
  return typeof raw === "string" && raw ? raw : undefined;
}

export default function (pi: ExtensionAPI) {
  const loaded = new Set<string>(); // absolute paths of skill files read this session
  const blocks = new Map<string, number>(); // addon file -> times blocked

  const reset = () => {
    loaded.clear();
    blocks.clear();
  };
  pi.on("session_start", reset);
  pi.on("session_compact", reset);

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) return undefined;
    const raw = inputPath(event.input);
    if (!raw) return undefined;
    const abs = expand(raw, ctx.cwd);
    if (abs.startsWith(SKILLS_DIR + path.sep)) loaded.add(abs);
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const raw = inputPath(event.input as Record<string, unknown>);
    if (!raw) return undefined;
    const abs = expand(raw, ctx.cwd);
    if (!isAddonFile(abs)) return undefined;

    const missing = requiredFor(abs)
      .map((rel) => path.join(SKILLS_DIR, rel))
      .filter((file) => existsSync(file) && !loaded.has(file));
    if (missing.length === 0) {
      blocks.delete(abs);
      return undefined;
    }

    const count = (blocks.get(abs) ?? 0) + 1;
    blocks.set(abs, count);
    if (count > MAX_BLOCKS) {
      ctx.ui?.notify?.(
        `require-skill-reads: letting ${path.basename(abs)} through after ${MAX_BLOCKS} blocks`,
        "warning",
      );
      return undefined;
    }

    return {
      block: true,
      reason:
        `Blocked: read the Odoo guidelines for this file type before editing ${abs}.\n` +
        `Open these with the read tool, then repeat the edit:\n` +
        missing.map((file) => `- ${file}`).join("\n") +
        `\nSKILL.md is only an index; the rules are in the guidelines/ files it links ` +
        `(relative to its skill directory). They must be read again after a context ` +
        `reset or compaction.`,
    };
  });
}
