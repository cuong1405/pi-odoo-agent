/**
 * Block file edits through the bash tool, so code changes go through `edit`/`write`
 * (which the other extensions can see and gate).
 *
 * Pi already sends the tool schemas to the model and returns validation and execution errors
 * (with the received arguments) as error results, so this file does not repeat either.
 *
 * Allowed on purpose: writing under /tmp, /dev and log/, and running a script that lives in
 * /tmp. That is the last resort for edits too complex for `edit`/`write`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCK_REASON =
  "Blocked: shell file edit. Use the `edit`/`write` tools for code changes; if one fails, " +
  "read its error message and the tool's schema, then retry with corrected arguments. " +
  "Only if the change is too complex for them, as a last resort: create a script under /tmp " +
  "with the `write` tool and run it (e.g. `python /tmp/fix.py`). Inline edits (sed -i, perl -i, " +
  "`>`/`>>` redirects, tee, python -c / heredoc writes) stay blocked outside /tmp, /dev and log/.";

const INTERPRETER_RE = /\b(?:python[0-9.]*|pypy[0-9.]*|node|ruby|perl|php)\b/;

/** File-writing calls inside inline interpreter code. */
const WRITE_API_RE = new RegExp(
  [
    String.raw`\bopen\s*\([^)]*['"][wax][bt+]*['"]`,
    String.raw`\.write(?:_text|_bytes|lines)?\s*\(`,
    String.raw`\b(?:writeFile|appendFile|createWriteStream|rename|unlink|rm)(?:Sync)?\s*\(`,
    String.raw`\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir)\s*\(`,
    String.raw`\bshutil\.(?:copy|copy2|copyfile|move|rmtree)\s*\(`,
    String.raw`\bfile_put_contents\s*\(`,
  ].join("|"),
);

/** Commands that modify files in place. Tested on the command with quoted text removed. */
const IN_PLACE_RE = [
  /\b(?:sed|gsed)\b[^|;&]*(?:\s-[a-zA-Z]*i|--in-place)/,
  /\bperl\b[^|;&]*\s-[a-zA-Z]*i/,
  /\bawk\b[^|;&]*-i\s+inplace/,
  /\bdd\b[^|;&]*\bof=/,
  /\btruncate\b[^|;&]*(?:-s\b|--size\b)/,
  /\bpatch\b/,
  /\bgit\s+apply\b/,
];

/** Remove quoted segments so prose in commit messages, `echo` or grep patterns can't trip the checks. */
function stripQuoted(command: string): string {
  return command
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function isScratchTarget(target: string): boolean {
  return (
    target.startsWith("/dev/") ||
    target.startsWith("/tmp/") ||
    target.startsWith("$TMPDIR") ||
    /(^|\/)log\//.test(target)
  );
}

/** `>`/`>>` or `tee` into a path outside /tmp, /dev and log/. */
function writesOutsideScratch(unquoted: string): boolean {
  const redirect = /(^|[^<>&0-9])>{1,2}\s*([^\s|;&)]+)/g;
  for (const match of unquoted.matchAll(redirect)) {
    const target = match[2] ?? "";
    if (target && !isScratchTarget(target)) return true;
  }
  const tee = /\btee\b((?:\s+\S+)+)/g;
  for (const match of unquoted.matchAll(tee)) {
    for (const target of (match[1] ?? "").trim().split(/\s+/)) {
      if (target.startsWith("-") || target === "''" || target === '""') continue;
      if (!isScratchTarget(target)) return true;
    }
  }
  return false;
}

function isShellFileEdit(command: string): boolean {
  const unquoted = stripQuoted(command);
  if (IN_PLACE_RE.some((re) => re.test(unquoted))) return true;
  if (writesOutsideScratch(unquoted)) return true;
  // Inline interpreter code keeps its quotes, so test the raw command. Stdout/stderr writes are harmless.
  const inline = command.replace(/\bsys\.std(?:out|err)\.write\s*\(/g, "");
  return INTERPRETER_RE.test(inline) && WRITE_API_RE.test(inline);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    return isShellFileEdit(command) ? { block: true, reason: BLOCK_REASON } : undefined;
  });
}
