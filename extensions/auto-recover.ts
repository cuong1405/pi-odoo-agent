/**
 * auto-recover: when a run of the main session ends in an error (after Pi's own automatic
 * retries are used up: 429 tpm limit, provider error, overload, timeout, ...), wait, compact
 * the session and resume the agent, instead of leaving an unattended session stopped.
 *
 * Why: in a long session the context is big, so every request costs many tokens and Pi's 3
 * quick retries (2s, 4s, 8s) all land inside the same per-minute limit. Pi's retry settings
 * stay as they are; this extension acts after they gave up.
 *
 * Trigger: Pi's `agent_settled` event, the final "Pi will not continue by itself" signal
 * (`agent_end` fires earlier, while a retry may still follow). The run counts as failed when
 * Pi's own outcome for it was "error" (`agent_before_settle` carries it; it is the stopReason
 * of the last assistant message). An abort (Escape) never triggers anything.
 *
 * Flow after a failed run:
 *  1. Stop if the error looks permanent (bad credentials, unknown model): waiting cannot help.
 *     Any other error, including a vague "Provider error" or an empty message, is recovered:
 *     the error text is never needed to decide, only to tell the human what happened.
 *  2. Stop if the cap of consecutive recoveries is reached (a recovery that fails again with no
 *     successful assistant response in between counts; any successful response, or a new user
 *     prompt, resets the count). The human is told and the session stays stopped.
 *  3. Wait at least 60 s (doubling on each consecutive recovery: 60, 120, 240 s) so the
 *     per-minute limit can reset. A new prompt, any other run starting, or the session
 *     ending during the wait cancels the recovery.
 *  4. Compact when the context is above 20k tokens (or its size is unknown): the compaction
 *     request itself carries the whole context, which is why the wait comes first. If the
 *     compaction fails, resume anyway.
 *  5. Send a custom message that starts a turn ("check your progress and continue; finish so
 *     the review gate runs if everything is done"). It is a custom message, not a user
 *     message, so the review stage of require-review-gate and the round counters of
 *     require-skill-reads are not restarted (they reset only on a user prompt).
 *
 * Task state: this extension does not know the task. After the compaction it relies on
 * require-review-gate, which answers any compaction it did not start itself with the task
 * state and next steps (from the requirements file and git). Without that gate the message
 * above still points the agent at the requirements file and git.
 *
 * Only interactive and RPC sessions are served: in print/JSON mode the process ends with the
 * run and nothing would wait for the timer.
 *
 * Install: copy to ~/.pi/agent/extensions/auto-recover.ts and run /reload.
 * Env: PI_AUTO_RECOVER=0                  turn the extension off
 *      PI_AUTO_RECOVER_MAX=3              consecutive recoveries before it gives up
 *      PI_AUTO_RECOVER_COOLDOWN_S=60      first wait in seconds (doubles each time, max 600)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "auto-recover";
const STATUS_KEY = "auto-recover";
/** Below this context size a compaction only costs a model call. */
const COMPACT_MIN_TOKENS = 20_000;
const MAX_WAIT_S = 600;
const COMPACT_INSTRUCTIONS =
  "Checkpoint after a provider error interrupted a long task. Keep: the task and the path of " +
  "its requirements file if there is one, every file changed and commit made, the commands and " +
  "tests run with their results, every problem still open and the next step. Drop exploration " +
  "and long tool output. Do not record the provider error, a time limit or missing " +
  "infrastructure as a constraint of the task.";

/** Errors where waiting and compacting cannot help. Everything else is recovered. */
const PERMANENT: RegExp[] = [
  // bad credentials
  /\b(?:status|code|http)\D{0,3}(?:401|403)\b/i,
  /^\W*(?:error\W+)?(?:401|403)\b/i,
  /\b(?:unauthori[sz]ed|forbidden)\b/i,
  /\b(?:invalid|incorrect|missing|expired|revoked)\s+(?:api[\s_-]*)?(?:key|token|credentials?)\b/i,
  /\bno\s+(?:api[\s_-]*key|credentials?)\b/i,
  /\bnot\s+authenticated\b|\bauthentication\s+(?:failed|error|required)\b/i,
  // a model that does not exist
  /\bmodel\b[^.\n]{0,60}\b(?:not\s+found|does\s+not\s+exist)\b/i,
  /\bunknown\s+model\b|\bno\s+such\s+model\b/i,
];

const looksPermanent = (error: string | undefined) =>
  !!error && PERMANENT.some((re) => re.test(error));

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}...` : one;
};

const envNumber = (name: string, fallback: number, min: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  ctx: ExtensionContext;
}

export default function (pi: ExtensionAPI) {
  const enabled = !/^(?:0|false|off|no)$/i.test((process.env.PI_AUTO_RECOVER ?? "").trim());
  const maxRecoveries = Math.floor(envNumber("PI_AUTO_RECOVER_MAX", 3, 1));
  const baseWaitS = envNumber("PI_AUTO_RECOVER_COOLDOWN_S", 60, 0);
  if (!enabled) return;

  let pending: Pending | undefined; // the recovery waiting for its timer
  let attempts = 0; // consecutive recoveries without a successful response in between
  let progress = true; // a successful assistant response came since the last recovery was set up
  let runStarts = 0; // runs started so far: a change during a recovery means something else took over
  let settleOutcome: string | undefined; // Pi's outcome of the run that is settling
  let lastError: string | undefined; // error text of the last assistant message, if it failed

  const tell = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") => {
    try {
      if (ctx.hasUI) ctx.ui.notify(`auto-recover: ${text}`, level);
    } catch {
      // a notification is a courtesy; never let it break the session
    }
  };

  const clearStatus = (ctx: ExtensionContext) => {
    try {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // see tell()
    }
  };

  /** Drop the recovery that is waiting for its timer, if any. */
  const cancel = (ctx?: ExtensionContext) => {
    const mine = pending;
    pending = undefined;
    if (!mine) return;
    clearTimeout(mine.timer);
    clearStatus(ctx ?? mine.ctx);
  };

  const reset = () => {
    cancel();
    attempts = 0;
    progress = true;
    settleOutcome = undefined;
    lastError = undefined;
  };

  const nudge = (attempt: number, error: string | undefined, compacted: boolean) =>
    `Auto-recover: the previous run stopped on a provider error` +
    `${error ? ` (${clip(error, 200)})` : ""} after Pi's own retries` +
    `${compacted ? ", and the session was compacted before resuming" : ""} ` +
    `(recovery ${attempt} of ${maxRecoveries}). The error came from the provider, not from your ` +
    `work, and nothing on disk was lost. Re-read the task requirements file (if the task has ` +
    `one) and \`git status\`, check your progress against them, and continue with the next ` +
    `unfinished step. If everything is done, finish so the review gate runs. Do not change your ` +
    `approach because of the error.`;

  /** The timer ran out: compact when the context is big, then start the turn. */
  const recover = (mine: Pending, attempt: number, error: string | undefined) => {
    if (pending !== mine) return;
    pending = undefined;
    const ctx = mine.ctx;
    clearStatus(ctx);
    try {
      if (!ctx.isIdle()) return; // another run is active and takes over
    } catch {
      return; // the context belongs to a replaced session
    }
    const startedAt = runStarts;
    let resumed = false;
    const resume = (compacted: boolean) => {
      if (resumed) return;
      resumed = true;
      try {
        if (runStarts !== startedAt || !ctx.isIdle()) return; // the human or another run came first
        pi.sendMessage(
          {
            customType: CUSTOM_TYPE,
            content: nudge(attempt, error, compacted),
            display: true,
            details: { attempt, max: maxRecoveries, error: error ? clip(error, 500) : undefined },
          },
          { triggerTurn: true },
        );
      } catch (failure) {
        tell(ctx, `could not resume the session (${(failure as Error)?.message ?? failure})`, "error");
      }
    };

    let tokens: number | null | undefined;
    try {
      tokens = ctx.getContextUsage()?.tokens;
    } catch {
      tokens = undefined;
    }
    if (tokens != null && tokens < COMPACT_MIN_TOKENS) {
      resume(false);
      return;
    }
    try {
      ctx.compact({
        customInstructions: COMPACT_INSTRUCTIONS,
        onComplete: () => resume(true),
        onError: (failure: Error) => {
          if (!/nothing to compact|already compact/i.test(failure.message)) {
            tell(ctx, `compaction failed (${clip(failure.message, 200)}), resuming without it`, "warning");
          }
          resume(false);
        },
      });
    } catch (failure) {
      const why = clip((failure as Error)?.message ?? String(failure), 200);
      tell(ctx, `compaction failed (${why}), resuming without it`, "warning");
      resume(false);
    }
  };

  pi.on("session_start", async () => {
    reset();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cancel(ctx);
    reset();
  });

  // Any run that starts (the human's prompt, the review gate's message, ...) replaces a recovery
  // that is still waiting; a prompt typed by the human also starts the counting again.
  pi.on("before_agent_start", async (event, ctx) => {
    runStarts++;
    cancel(ctx);
    if ((event as { messageType?: string }).messageType === "user") {
      attempts = 0;
      progress = true;
    }
    return undefined;
  });

  pi.on("message_end", async (event) => {
    const message = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
    if (message?.role !== "assistant") return undefined;
    if (message.stopReason === "error") {
      lastError = message.errorMessage?.trim() || "unknown provider error";
    } else {
      lastError = undefined;
      if (message.stopReason !== "aborted") progress = true;
    }
    return undefined;
  });

  // Pi's own verdict on the run that is about to settle ("completed" | "aborted" | "error").
  pi.on("agent_before_settle", async (event) => {
    settleOutcome = (event as { outcome?: string }).outcome;
    return undefined;
  });

  pi.on("agent_settled", async (event, ctx) => {
    const outcome = settleOutcome;
    const error = lastError;
    settleOutcome = undefined;
    lastError = undefined;
    if (event.aborted) return;
    // No outcome means the run ended without reaching the boundary (a thrown error): fall back
    // to the last assistant message.
    const failed = outcome === "error" || (outcome === undefined && error !== undefined);
    if (!failed) return;
    if (ctx.mode === "print" || ctx.mode === "json") return; // nothing would wait for the timer

    if (looksPermanent(error)) {
      const why = clip(error ?? "", 200);
      tell(ctx, `not recovering, the error looks permanent (${why}). Fix it and send a prompt.`, "error");
      return;
    }
    if (progress) attempts = 0;
    if (attempts >= maxRecoveries) {
      tell(
        ctx,
        `giving up after ${maxRecoveries} recoveries without a successful response. Last error: ` +
          `${clip(error ?? "unknown provider error", 200)}. Send a prompt to continue.`,
        "error",
      );
      return;
    }
    attempts++;
    progress = false;
    cancel(ctx);

    const attempt = attempts;
    const waitS = Math.min(baseWaitS * 2 ** (attempt - 1), MAX_WAIT_S);
    const mine: Pending = { ctx, timer: setTimeout(() => recover(mine, attempt, error), waitS * 1000) };
    pending = mine;
    try {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `recovering at ${clock(Date.now() + waitS * 1000)}`);
    } catch {
      // see tell()
    }
    const what = error ? ` (${clip(error, 200)})` : "";
    tell(
      ctx,
      `the run stopped on a provider error${what}. Recovery ${attempt}/${maxRecoveries}: ` +
        `waiting ${waitS}s, then compacting and resuming. Send a prompt to cancel it.`,
      "warning",
    );
  });
}
