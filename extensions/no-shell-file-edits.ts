/**
 * Hard block: never edit files through the bash tool.
 *
 * pi's default toolset is exactly four tools. Only these are assumed here;
 * everything else (grep, find, ls, codemode, …) is opt-in and may be inactive:
 *   read  { path, offset?, limit? }                 inspect text or images
 *   edit  { path, edits: [{ oldText, newText }, …] } targeted change
 *   write { path, content }                         full-file replacement
 *   bash  { command, timeout? }                     real commands only
 *
 * Because grep/find/ls are off by default, shell search and listing commands
 * (grep, rg, find, ls, …) stay available through bash.
 *
 * The `edit` schema is NOT `{ path, oldString, newString }`. `edits` is a
 * top-level array next to `path`, it must contain at least one replacement, and
 * every edits[].oldText must match a unique, non-overlapping region of the
 * original file. Edits are matched against the original file, not incrementally.
 *
 * When a file tool fails, the model must re-read the exact region, fix the
 * arguments and retry the same tool. Falling back to sed/perl/awk/python/node/
 * ruby/tee/redirection is blocked here, before the command runs.
 *
 * Bash stays available for real commands: tests, servers, git, package
 * managers, psql, log inspection, etc.
 */

import {
  createEditToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";

const TOOL_SCHEMA_HELP =
  "pi's default file tools (exact schemas): " +
  "`read` {path, offset?, limit?}; " +
  "`edit` {path, edits: [{oldText, newText}]} — `edits` is a required, non-empty array; " +
  "each oldText must match a unique, non-overlapping region of the original file; " +
  "`write` {path, content}; " +
  "`bash` {command, timeout?} for real commands.";

const FILE_TOOL_HELP =
  `File edits are blocked in the shell. Use the file tools instead. ${TOOL_SCHEMA_HELP} ` +
  "If `edit` fails because an oldText was not found or was ambiguous, re-read the exact " +
  "region (same indentation/line endings) and retry `edit` with a corrected, exact, " +
  "non-overlapping oldText. Do not re-implement the edit with bash, sed, awk, perl, python, " +
  "node, ruby, tee, dd, truncate, or shell redirection.";

const RETRY_NOTE =
  "The tool call above failed. Do NOT fall back to bash or any shell edit. " +
  "Re-read the tool schema and retry the same file tool with corrected arguments. " +
  `${TOOL_SCHEMA_HELP} ` +
  "For `edit`, re-read the exact file region first so every oldText matches including " +
  "whitespace and line endings; keep edits short, unique, and non-overlapping.";

const FILE_TOOL_NAMES = new Set(["read", "edit", "write"]);

const INTERPRETER_RE = /\b(?:python[0-9.]*|pypy[0-9.]*|node|ruby|perl|php)\b/;

const WRITE_API_RE = new RegExp(
  [
    String.raw`\bopen\s*\([^)]*['"][wax][bt+]*['"]`,
    String.raw`\.write(?:_text|_bytes|lines)?\s*\(`,
    String.raw`\b(?:writeFile|appendFile|createWriteStream|rename|unlink|rm)(?:Sync)?\s*\(`,
    String.raw`\bFile\.(?:write|open)\s*\(`,
    String.raw`\bIO\.write\s*\(`,
    String.raw`\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir)\s*\(`,
    String.raw`\bshutil\.(?:copy|copy2|copyfile|move|rmtree)\s*\(`,
    String.raw`\b(?:Path|pathlib\.Path)\s*\([^)]*\)\s*\.(?:write_text|write_bytes|unlink|rename|replace)\s*\(`,
    String.raw`\bfile_put_contents\s*\(`,
    String.raw`\b(?:save|saveAs|write)\s*\(\s*['"][^'"]+\.(?:py|xml|js|ts|scss|css|json|md|csv)['"]`,
  ].join("|"),
);

const IN_PLACE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sed|gsed)\b[\s\S]*?(?:\s-i(?:\s|['"]|\.|$)|--in-place)/, "sed -i"],
  [/\bperl\b[\s\S]*?\s-(?:i|pi|ni|ip|in)(?:\.\w+)?\b/, "perl -i"],
  [/\bawk\b[\s\S]*?-i\s+inplace/, "awk -i inplace"],
  [/\b(?:yq|dasel)\b[\s\S]*?\s-i\b/, "yq/dasel -i"],
  [/\bdd\b[\s\S]*?\bof=/, "dd of="],
  [/\btruncate\b[\s\S]*?(?:-s\b|--size\b)/, "truncate"],
  [/\b(?:vim|nvim|vi)\b[\s\S]*?(?:-c\s*['"]?(?:wq|w\b|x\b)|--headless)/, "editor write"],
];

/** Remove quoted segments so prose, `echo`, and tests containing ">" don't trip the redirect check. */
function stripQuoted(command: string): string {
  return command
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Redirection into a source-ish path (not /dev, not temporary/log output). */
function hasSourceRedirect(command: string): boolean {
  const unquoted = stripQuoted(command);
  const re = /(^|[^<>&0-9])>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s|;&)]+))/g;
  for (const match of unquoted.matchAll(re)) {
    const target = match[2] ?? match[3] ?? match[4] ?? "";
    if (!target) continue;
    if (target.startsWith("/dev/")) continue;
    if (target.startsWith("/tmp/") || target.startsWith("$TMPDIR")) continue;
    if (/(^|\/)log\//.test(target)) continue;
    return true;
  }
  return false;
}

/** `tee`/`tee -a` writing outside /tmp and log/. */
function hasTeeWrite(command: string): boolean {
  const re = /\btee\b((?:\s+(?:-a|--append))?(?:\s+(?:"[^"]+"|'[^']+'|\S+))+)/g;
  for (const match of command.matchAll(re)) {
    const args = match[1] ?? "";
    const targets = args.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
    for (const raw of targets) {
      const target = raw.replace(/^["']|["']$/g, "");
      if (target.startsWith("-")) continue;
      if (target.startsWith("/dev/")) continue;
      if (target.startsWith("/tmp/") || target.startsWith("$TMPDIR")) continue;
      if (/(^|\/)log\//.test(target)) continue;
      return true;
    }
  }
  return false;
}

function mutationReason(command: string): string | null {
  for (const [pattern, label] of IN_PLACE_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked shell file edit (${label}). ${FILE_TOOL_HELP}`;
    }
  }

  if (INTERPRETER_RE.test(command) && WRITE_API_RE.test(command)) {
    return `Blocked interpreter file write. ${FILE_TOOL_HELP}`;
  }

  // Interpreter shelling out to an editor (python subprocess/os.system, node child_process).
  if (
    INTERPRETER_RE.test(command) &&
    /\b(?:subprocess|os\.system|os\.popen|child_process|execSync|spawnSync)\b/.test(command) &&
    /\b(?:sed|perl|awk|tee|dd|truncate|cp|mv|rm)\b/.test(command)
  ) {
    return `Blocked interpreter-driven shell file edit. ${FILE_TOOL_HELP}`;
  }

  if (hasTeeWrite(command)) {
    return `Blocked tee writing to a file. ${FILE_TOOL_HELP}`;
  }

  if (hasSourceRedirect(command)) {
    return `Blocked shell redirection into a file. ${FILE_TOOL_HELP}`;
  }

  return null;
}

type EditPair = { oldText: string; newText: string };

/**
 * Turn one item from `edits` into a {oldText,newText} pair, accepting the
 * legacy/wrong `oldString`/`newString` names too. Returns undefined when the
 * item carries no usable pair; pi then reports the original validation error.
 */
function asEditPair(value: unknown): EditPair | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const oldText = record.oldText ?? record.oldString;
  const newText = record.newText ?? record.newString;
  if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
  return { oldText, newText };
}

/**
 * Normalize raw `edit` arguments before pi validates them.
 *
 * The built-in `edit` schema is `{ path, edits: [{ oldText, newText }] }`.
 * Models (and earlier versions of this extension) sometimes send
 * `{ path, oldString, newString }`, a JSON string for `edits`, or a single edit
 * object instead of an array. Fold all of those into the real shape so the call
 * succeeds with the correct schema instead of failing validation and tempting a
 * shell fallback. Runs before schema validation, so it must return a valid input.
 */
function normalizeEditArguments(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

  const args = raw as Record<string, unknown>;
  const edits: EditPair[] = [];

  const push = (value: unknown) => {
    const pair = asEditPair(value);
    if (pair) edits.push(pair);
  };

  let rawEdits = args.edits;
  if (typeof rawEdits === "string") {
    try {
      rawEdits = JSON.parse(rawEdits);
    } catch {
      rawEdits = undefined;
    }
  }

  if (Array.isArray(rawEdits)) {
    for (const item of rawEdits) push(item);
  } else if (rawEdits !== undefined) {
    push(rawEdits);
  }

  // Legacy/wrong top-level shape: {path, oldText, newText} or {path, oldString, newString}.
  push(args);

  if (edits.length === 0) return raw;

  const normalized: Record<string, unknown> = { ...args, edits };
  delete normalized.oldText;
  delete normalized.newText;
  delete normalized.oldString;
  delete normalized.newString;
  return normalized;
}

export default function (pi: ExtensionAPI) {
  // Override the built-in edit tool with the same implementation but a
  // prepareArguments shim that repairs the wrong/legacy argument shapes before
  // schema validation. The built-in prepareArguments already handles top-level
  // oldText/newText; this one also handles oldString/newString and stringified
  // or single-object `edits`.
  const builtinEdit = createEditToolDefinition(process.cwd());
  pi.registerTool({
    ...builtinEdit,
    prepareArguments: (args) =>
      normalizeEditArguments(args) as Static<typeof builtinEdit.parameters>,
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") {
      return undefined;
    }
    const command = String(
      (event.input as { command?: unknown }).command ?? "",
    );
    const reason = mutationReason(command);
    if (reason) {
      return { block: true, reason };
    }
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    if (!event.isError) return undefined;
    if (!FILE_TOOL_NAMES.has(event.toolName)) return undefined;
    const content = Array.isArray(event.content) ? [...event.content] : [];
    content.push({ type: "text", text: RETRY_NOTE });
    return {
      content,
      ...(event.structuredContent !== undefined
        ? { structuredContent: event.structuredContent }
        : {}),
    };
  });
}
