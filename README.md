# pi-setup

Only the parts that are ours: the agent's instructions and its extensions. The sandbox script,
`odoo.conf`, skills and credentials are managed separately (the skills and bwrap script come from
Odoo's own setup).

| File | Install to |
|---|---|
| `AGENTS.md` | `~/src/odoo/AGENTS.md` |
| `extensions/no-shell-file-edits.ts` | `~/.pi/agent/extensions/` |
| `extensions/describe-screenshot.ts` | `~/.pi/agent/extensions/` |
| `extensions/require-skill-reads.ts` | `~/.pi/agent/extensions/` |
| `extensions/require-review-gate.ts` | `~/.pi/agent/extensions/` |
| `skills/odoo-task-requirements/` | `~/.pi/agent/skills/` |

```bash
cp AGENTS.md ~/src/odoo/AGENTS.md
cp extensions/*.ts ~/.pi/agent/extensions/      # then restart pi
cp -r skills/odoo-task-requirements ~/.pi/agent/skills/
```

Copy, don't symlink: the sandbox only mounts `~/.pi` and `~/src/odoo`, so a symlink into this
repo would dangle inside it. The agent can edit both locations (read-write mounts), so after a
session run `diff -r extensions ~/.pi/agent/extensions` and `diff AGENTS.md ~/src/odoo/AGENTS.md`.

`describe_screenshot` models can be overridden with
`PI_VISION_MODELS="provider/modelId,provider/modelId"` (split on the first `/`).

`require-skill-reads` reviews every `edit`/`write` of addon code with a small model before it is
applied (default chain `kilo/particle-ai/particle-1:free`, `kilo/stealth/glyph-cluster`, `kilo/reflection/beam-free`; one stateless call per skill per assistant message, so the
provider must be configured in Pi like for `describe_screenshot`). Overrides:
`PI_GUIDELINE_REVIEW_MODELS="provider/modelId,provider/modelId"` (split on the first `/`),
`PI_GUIDELINE_REVIEW_MAX_ROUNDS=5` (fresh review rounds with open findings before a change is let
through with a warning; `0` never lets it through), `PI_SKILLS_DIR` (default `~/.pi/agent/skills`)
and `ODOO_RC` (the `odoo.conf` whose `addons_path` marks addon code, default
`~/src/odoo/config/odoo.conf`). It reads `SKILL.md` and `guidelines/**.md` of `odoo-guidelines` and
`odoo-web-guidelines` from disk on every review, so updating those skills updates the gate.

Browser: `AGENTS.md` hard-codes the Ubuntu snap path (`/snap/chromium/current/...`), so it is
meant for the Ubuntu VPS. Your sandbox script must expose that path (bind `/snap`). Smoke test
after install: one unit-test run with N > 0, one browser test, one `describe_screenshot` call.
