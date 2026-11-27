# Odoo 20.0 - AGENTS.md

You build Odoo 20.0 addons on a long autonomous run. A human reads only the final result and
expects it to meet the original requirements. Time is not a constraint, thoroughness is:
spend it on verification, not on asking.

## How a task runs

1. **Start: `odoo-task-requirements`.** Load it before any code (anything beyond a one-line
   fix). It maps the prompt to the guideline sections that apply, you read them, and it
   writes the requirements file `~/src/odoo/log/<task>_requirements.json`. That file is the
   single source of truth for the contract and its `review` results. While the task is open,
   apply any follow-up requirement changes to the file before changing code.
2. **Build in small steps.** Whenever you analyse, write or edit a file, first open the
   guideline sections that cover it (index in the skill's `SKILL.md`, whole file, not from
   memory) **and the matching file of `odoo-guideline-examples`**: real Odoo code, good and
   bad, for each section, so you compare your code with what the rule looks like before you
   write it. Commit as you go.
3. **After every change, run the checks** below, cheapest first. Do not stack unverified
   changes.
4. **Finish: the review gate.** When you try to finish, the `require-review-gate` extension
   holds the turn open until you have reviewed the work with `odoo-review` against the
   requirements file and fixed what it found. Its message gives the exact steps and the bar,
   opens with the task state read from the file and git, and ends with next steps in priority
   order. After compaction of an open task, resume from the posted state and the files.
   A passing review completes the task. A user invocation of
   `/skill:odoo-task-requirements` reopens it for a fresh review. Apply any changes
   supplied with the invocation to the requirements file.

## Ground truth

- The Odoo source is `~/src/odoo/odoo/`, branch `20.0`. Your memory of Odoo is of older
  versions (`attrs=`, `<tree>`, `name_get`, `read_group` are gone). Before you write or flag an
  API, attribute or view syntax, `git grep` the source for it. The source is a reference: read
  it, never edit it.
- The house rules are the Odoo skills in `~/.pi/agent/skills/<skill>/`. A relative link inside
  a guideline (`tests.md`) is relative to the guideline file that holds it. Where a guideline
  disagrees with habit, the guideline wins; on any blockage, re-read the guideline that covers
  the construct before guessing.

| Skill | Load it when |
|---|---|
| `odoo-task-requirements` | the start of a task, follow-ups that change open requirements, and user invocations after completion |
| `odoo-guidelines` | writing any file of an addon outside `static/` |
| `odoo-web-guidelines` | writing JS, Owl templates, SCSS or hoot tests under `static/` |
| `odoo-guideline-examples` | with each of the two above, for every file you analyse, write or edit |
| `odoo-security` | `sudo`, routes, ACLs, public methods, raw SQL |
| `odoo-git` | writing a commit message or naming a branch |
| `odoo-stable-policy` | the change targets a released Odoo version rather than a custom addon on top of it |
| `odoo-browser-tests` | the task has any UI requirement |
| `odoo-review` | the review gate asks for it when you try to finish |

Change files with `edit`/`write` only; shell edits (`sed -i`, redirects, `tee`, inline
`python -c`) are blocked. If a change is too complex for those tools, as a last resort write
a script under `/tmp` with `write` and run it.

## Environment

| Item | Value |
|---|---|
| Odoo source | `~/src/odoo/odoo/` (`odoo-bin`, package `odoo/odoo/`), branch `20.0` |
| Python | `~/src/odoo/.venv/bin/python` (always this one; packages go in with `uv pip install --python ~/src/odoo/.venv/bin/python ...`, never bare `pip`) |
| Lint | `~/src/odoo/.venv/bin/ruff` with Odoo's own config `~/src/odoo/odoo/ruff.toml` |
| Config | `~/src/odoo/config/odoo.conf`, defines addons_path, http_port, etc. |
| Logs | `~/src/odoo/log/` (create if needed) |
| PostgreSQL | system package, >= 16 |

`import odoo` works only with cwd `~/src/odoo/odoo` or `PYTHONPATH` set; running `odoo-bin`
as below avoids the problem.

## Databases

- **`pouet`** is the only deployment database. Never overwrite, drop, reinstall or
  repurpose it, and never run tests on it. Never act on it to get around a blocker.
- **Test databases** (`test_<module>`) are for all development, unit tests and QA. Create
  them with `-i <module> --without-demo`, and **drop them when finished** (`dropdb <name>`).
  Reuse one per task instead of creating many.

## Running Odoo

```bash
~/src/odoo/.venv/bin/python ~/src/odoo/odoo/odoo-bin --config=~/src/odoo/config/odoo.conf \
  -d <db> <ops> --stop-after-init --logfile=~/src/odoo/log/<name>.log
```

`<ops>` is `-i <module>` (install), `-u <module>` (update) or a test run. Only add arguments
`odoo.conf` does not cover (`-d`, `-i`, `-u`, `--test-tags`, `--stop-after-init`, `--logfile`,
`--http-port`).

- **One run = one fresh log.** Odoo appends to `--logfile`, so a reused file mixes old
  failures with the new run. Before every run delete the log (`rm -f <log>`) or use a unique
  name (`<name>_$(date +%Y%m%d_%H%M%S).log`), and read only that file.
- Always foreground: never `&` with `--stop-after-init`.
- `--test-enable` always comes with an explicit `--test-tags`. On a fresh DB a bare
  `--test-enable` also runs the tests of every newly installed dependency (>10 minutes).
  Install first with `--stop-after-init` only, then run the tests with `-u`.
- Tag forms: `/module`, `:Class`, `:Class.method`, `-tag` to exclude. `/test_file.py` and a
  bare `post_install` do not match. A test only runs if the module is installed in that DB:
  `psql -d <db> -c "SELECT state FROM ir_module_module WHERE name='<module>'"`.
- A change to addon code, JS, SCSS, templates or `ir.asset`/`ir.ui.view` data needs a server
  restart on the served DB; `-u` alone leaves stale assets.
- Servers: start one only inside your own session and record its pid
  (`nohup ... & echo $! > ~/src/odoo/log/server.pid`); stop it with
  `kill "$(cat ~/src/odoo/log/server.pid)"`. Never `pkill -f`/`killall`. If a port is busy and
  no pid file is yours, use another `--http-port` or report it.
- `--dev=reload,xml` is for interactive iteration only, never in a check.

## Checks, cheapest first

Run these after every change that touches what they cover. Each failure message says what is
wrong and where; act on it before forming your own hypothesis.

1. `~/src/odoo/.venv/bin/python -m py_compile <file>` on every Python file you changed.
2. `~/src/odoo/.venv/bin/ruff check --config ~/src/odoo/odoo/ruff.toml <changed .py files>`.
   Fix what it reports on lines you wrote; do not reformat code you did not touch.
3. Install into a new test DB (`-i <module> --without-demo`) to catch XML, ACL and manifest
   errors, then `-u <module>` on a DB that already has it.
4. Unit tests, hard selection: `-d test_<module> -u <module> --test-enable --test-tags
   '/<module>' --log-handler=:INFO`. Iterate on one failure with `'/<module>:TestFoo'` or
   `'/<module>:TestFoo.test_bar'`, then run the whole module once.
5. UI requirements: load `odoo-browser-tests`. A green browser test alone verifies nothing.

### Reading results

Read only the log of the run you just made. A log with more than one run is invalid: delete it
and re-run. Never report green from a run with N = 0, from a different tag spec than the
check, or from a log you did not read.

1. `grep odoo.tests.result <log>` must show exactly one line, `0 failed, 0 error(s) of N tests`
   with **N > 0**. Ignore `odoo.tests.stats`. N = 0 means a wrong tag spec or an uninstalled
   module: it still exits 0 and is a failure of the run, not a pass.
2. `grep -E 'ERROR|Traceback' <log>`: none from your module. Failures exit 1, so also check
   the exit code.
3. Benign noise: `collation version mismatch`, `markdown2 is not installed`.

On a failure, read the `FAIL:` / `ERROR:` block first: the test's own message comes before the
traceback.

## Writing tests that diagnose

When a test fails you see only its output, and by then the guidelines you read may be many
steps behind you. Write the tests for the behaviour the task's requirements describe, not for
every line of code, and make each failure diagnosable from its message alone. Every assertion
that can fail carries a `msg` with, in order:

1. **Scenario**: the action and the key inputs.
2. **Expected vs actual**: both values, plus the record (`display_name` / `model(id)`).
3. **Look at**: the `Model.method` or field that computes or enforces it, plus any
   `@api.depends`, `@api.constrains`, ACL line, record rule or view XML id involved.
4. **Likely cause**: one line.
5. **Guideline**: the guideline file and section that cover the construct under test, and the
   matching `odoo-guideline-examples` file, as paths under `~/.pi/agent/skills/`, with the
   instruction to read both whole before changing the code.

```python
self.assertEqual(
    order.amount_total, 120.0,
    f"Confirm {order.display_name} with 2 lines of 60.0: expected amount_total=120.0, "
    f"got {order.amount_total}. Look at: sale.order._compute_amount_total and its "
    f"@api.depends (does it include 'line_ids.price_subtotal'?). "
    f"Likely: stale compute after a line write. "
    f"Guideline: odoo-guidelines/guidelines/orm.md, 'Computes, onchange and constraints', and "
    f"odoo-guideline-examples/examples/examples_orm.md (read both whole before changing the code).",
)
```

- Name only suspects and guidelines you verified exist (`grep` the method, field or file
  first). A wrong hint is worse than none; if you cannot name a real suspect, give scenario
  plus expected vs actual. If a run proves a hint wrong, fix it in the same change.
- Build the scenario in `setUpClass` with named values, so messages can interpolate them. One
  behaviour per method, named `test_<model>_<action>_<expected>`. Several fields on several
  records: `assertRecordValues`, wrapped in a helper that appends the method or field to
  inspect (it takes no `msg`). Several inputs: `self.subTest(case=...)`.
- Expected errors: `assertRaisesRegex(ValidationError, "<key phrase>")` plus `mute_logger`,
  and `self.cr.savepoint()` when the transaction continues. Access: assert with a concrete
  user and operation and name the ACL line or record rule.
- Compute, onchange and constraint tests assert the *trigger* (change the dependency, then
  check the result). No vacuous passes: assert a recordset is non-empty before looping.

## Autonomous operation

- **Do not stop to ask.** Resolve ambiguity yourself: pick the interpretation closest to the
  stated requirement and to Odoo conventions (skills, then the 20.0 source) and record it
  under Assumptions. You cannot hand the turn back.
- If something truly blocks a requirement (missing credentials, contradictory requirements),
  note exactly what blocks you and what you tried, try another approach, and keep working on
  the rest. Task size, time and "missing infrastructure" are never blockers: a feeling that
  the task is too large is a sign of a long context. Re-read the requirements file, take the
  next step on its list, and keep going.
- **Never game the result.** Never weaken, delete, skip or `expectedFailure` a test to get
  green; changing an expected value needs a requirement-based reason in the commit message.
  Never widen a regex, catch-all `except` or loosen an access rule to make a test pass. Never
  mark a finding `fixed` without a run you saw pass this session. If a test fails, decide
  first whether the code misses the requirement (fix the code), the test asserts something the
  requirement does not state (fix the test and name the requirement), or the requirement is
  ambiguous (record the interpretation). A second failed fix attempt is a stop sign: re-read
  the guideline section and the source, then change approach.

## Finishing

If the requirements file does not exist when you try to finish, the gate does not run: say
plainly in your final message that the file was missing and the work was not reviewed, and
stop. Otherwise the gate's bar is: every MUST requirement met, at least 90% of all
requirements met, at least 90% of the findings fixed with a commit that exists. Run each
requirement's Check fresh; a weakened test, relaxed threshold or shortfall is a finding even
if you think it is justified.

Have these done before you try to finish, since the review will find them otherwise:

- A fresh install on a new test DB and a `-u` on a DB that already has the module, both
  succeeding (also with demo data if the module ships demo).
- The full module suite green with N > 0 after your last code change; no `ERROR`,
  `Traceback` or unexpected `WARNING` from your module in the logs.
- `ruff` clean on the lines you wrote; `git status` clean apart from intended changes (commit
  them, remove debug code and stray files).
- For UI tasks: the browser test ran and every screenshot was inspected.

The review also covers what the guidelines do not spell out: negative cases (wrong user or
group, empty or multi-record sets, multi-company, archived records, duplicate or invalid input,
cancel and reopen), access (new models without ACL rows, `sudo()` without justification,
record rules that leak across companies, public methods callable by users who should not),
and data and upgrade (new required fields without defaults on existing records, `-u` on a
populated DB, XML ids stable and unique).

### Final report (what the human reads)

Short and evidence-based:

1. Outcome vs the original task in one paragraph, with the review score (for example
   `9/10 findings fixed, 1 flagged`).
2. The requirements, each with its test name and evidence.
3. Assumptions and decisions, each with the reason.
4. Gate evidence: commit hash, exact commands, the `odoo.tests.result` line with N, log paths.
5. Known gaps, risks and anything that needs a human decision. If something is not done or
   not verified, say so: a smaller honest result beats a larger unverified one.
