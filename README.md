# pi-setup

Only the parts that are ours: the agent's instructions and its extensions. The sandbox script,
`odoo.conf`, skills and credentials are managed separately (the skills and bwrap script come from
Odoo's own setup).

| File | Install to |
|---|---|
| `AGENTS.md` | `~/src/odoo/AGENTS.md` |
| `extensions/no-shell-file-edits.ts` | `~/.pi/agent/extensions/` |
| `extensions/describe-screenshot.ts` | `~/.pi/agent/extensions/` |
| `extensions/require-review-gate.ts` | `~/.pi/agent/extensions/` |
| `extensions/auto-recover.ts` | `~/.pi/agent/extensions/` |
| `skills/odoo-task-requirements/` | `~/.pi/agent/skills/` |
| `skills/odoo-browser-tests/` | `~/.pi/agent/skills/` |
| `skills/odoo-guideline-examples/` | `~/.pi/agent/skills/` |

```bash
cp AGENTS.md ~/src/odoo/AGENTS.md
cp extensions/*.ts ~/.pi/agent/extensions/      # then restart pi
cp -r skills/odoo-task-requirements skills/odoo-browser-tests skills/odoo-guideline-examples ~/.pi/agent/skills/
```

Copy, don't symlink: the sandbox only mounts `~/.pi` and `~/src/odoo`, so a symlink into this
repo would dangle inside it. The agent can edit both locations (read-write mounts), so after a
session run `diff -r extensions ~/.pi/agent/extensions` and `diff AGENTS.md ~/src/odoo/AGENTS.md`.

`describe_screenshot` models can be overridden with
`PI_VISION_MODELS="provider/modelId,provider/modelId"` (split on the first `/`).

For each task, `odoo-task-requirements` records acceptance checks and applicable
guidelines in `~/src/odoo/log/<task>_requirements.json`. When Pi tries to finish,
`require-review-gate` requests a fresh `odoo-review` and checks the results in the
same file. The extension uses the JSON schema shipped with the skill.

Install the extension, the full requirements skill directory, and `AGENTS.md`
together. For an in-progress Markdown task, copy the contract into the JSON
example, preserve the base commit and requirement IDs, and start with
`"review": null`.

`auto-recover` resumes a session whose run ended in a provider error after Pi's own retries
(429 tokens-per-minute limit, `Provider error`, overload, timeout, ...). It waits at least 60 s
(doubling: 60, 120, 240 s), compacts the session when the context is above 20k tokens, and sends
a custom message that starts a turn ("check your progress and continue; finish so the review
gate runs"). `require-review-gate` adds the task state and next steps after the compaction. A new
prompt, another run starting or an abort (Escape) cancels it; 3 recoveries in a row without a
successful response, or a permanent-looking error (bad credentials, unknown model), stop it with
a notice. Pi's own retry settings are untouched. It serves interactive and RPC sessions only.
Overrides: `PI_AUTO_RECOVER=0` (off), `PI_AUTO_RECOVER_MAX=3`, `PI_AUTO_RECOVER_COOLDOWN_S=60`.

Browser: `AGENTS.md` hard-codes the Ubuntu snap path (`/snap/chromium/current/...`), so it is
meant for the Ubuntu VPS. Your sandbox script must expose that path (bind `/snap`). Smoke test
after install: one unit-test run with N > 0, one browser test, one `describe_screenshot` call.

`odoo-guideline-examples` is generated: `python3 tools/build_guideline_examples.py` copies the code
blocks verbatim from `git show <commit>:<path>` of the Odoo checkout (`~/src/odoo/odoo`), so the
curated part is only which file and line range illustrates which guideline section. Rerun it after
re-checking the ranges when Odoo's source or its guidelines change. The `odoo-*` skills installed
in `~/.pi/agent/skills` should be refreshed from the checkout's `skills/` directory too (the
guidelines grew, and `odoo-stable-policy` is new).
