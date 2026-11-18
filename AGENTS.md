# Odoo 20.0 - AGENTS.md

Project-specific environment, commands and test-reporting rules. The Odoo skills hold the
house rules for ORM, fields, XML, security, tests and JS/SCSS; where a guideline disagrees
with habit, the guideline wins, and on any blockage re-read the guideline file that covers the
construct before guessing.

## Skills

Skills live in `~/.pi/agent/skills/<skill>/`. A relative link inside a guideline (`tests.md`)
is relative to that skill's directory: `~/.pi/agent/skills/odoo-guidelines/guidelines/tests.md`.

- **Edits and writes of addon code are gated** by the `require-skill-reads` extension. Walk
  the guideline index in your system prompt (`odoo_guideline_index`; rows `G*` for everything
  outside `static/`, `W*` for `static/src` and `static/tests`): one `guideline_row` call per
  row, all in one message, then in the next message one `guideline_check` call first and your
  edits after it. Quotes are verified, and a `complies: false` check needs a `fix` that the
  edit must contain. Every batch of edits needs a new walk, even if you walked a moment ago.
  If you edit first, the block message shows the rows and repeats the steps. You never open
  the `SKILL.md` of these two skills.
- Change files with `edit`/`write` only; shell edits (`sed -i`, redirects, `tee`, inline
  `python -c`) are blocked. If a change is too complex for those tools, as a last resort write
  a script under `/tmp` with `write` and run it.
- Load these yourself when relevant: `odoo-security` (`sudo`, routes, ACLs, public methods,
  raw SQL), `odoo-git` (commit message, branch). The review gate requests `odoo-review` when
  you try to finish (see "Finishing: the review gate").

## Environment

| Item | Value |
|---|---|
| Odoo source | `~/src/odoo/odoo/` (`odoo-bin`, package `odoo/odoo/`), branch `20.0` |
| Python | `~/src/odoo/.venv/bin/python` (always this one; packages go in with `uv pip install --python ~/src/odoo/.venv/bin/python ...`, never bare `pip`) |
| Config | `~/src/odoo/config/odoo.conf`, defines addons_path, http_port, etc. |
| Logs | `~/src/odoo/log/` (create if needed) |
| Screenshots | `/tmp/odoo_tests/<db>/screenshots/` (Odoo default, `--screenshots` overrides) |
| Chromium | `ODOO_BROWSER_BIN=/snap/chromium/current/usr/lib/chromium-browser/chrome` (snap `current` symlink) |
| PostgreSQL | system package, >= 16 |

The Odoo source is a reference: read it to verify 20.0 behaviour, do not edit it.
`import odoo` works only with cwd `~/src/odoo/odoo` or `PYTHONPATH` set; running `odoo-bin`
as below avoids the problem.

## Databases

- **`pouet`** is the only deployment database. Never overwrite, drop, reinstall or
  repurpose it, and never run tests on it.
- **Test databases** (e.g. `test_<module>`) are for all development, unit tests and QA.
  Create them with `-i <module> --without-demo`, and **drop them when finished**
  (`dropdb <name>`). Reuse one per task instead of creating many.

## Command template

```bash
~/src/odoo/.venv/bin/python ~/src/odoo/odoo/odoo-bin --config=~/src/odoo/config/odoo.conf \
  -d <db> <ops> --stop-after-init --logfile=~/src/odoo/log/<name>.log
```

`<ops>` is `-i <module>` (install), `-u <module>` (update) or a test run (below). Only add
arguments `odoo.conf` does not cover (`-d`, `-i`, `-u`, `--test-tags`, `--stop-after-init`,
`--logfile`, `--http-port`). **One run = one fresh log.** Odoo appends to `--logfile`, so a
reused file mixes old failures with the new run and you will misread the result. Before every
run, delete the log (`rm -f <log>`) or use a unique name (`<name>_$(date +%Y%m%d_%H%M%S).log`),
and read only that file. Never read a log you did not just produce.

```bash
# Fresh install into a test DB (no demo data)
... -d test_<module> -i <module> --without-demo --stop-after-init --logfile=~/src/odoo/log/install_<module>.log

# Unit tests for the module (hard selection, never bare --test-enable)
... -d test_<module> -u <module> --test-enable --test-tags '/<module>' \
    --log-handler=:INFO --logfile=~/src/odoo/log/test_<module>.log

# One class / one method while iterating on a failure
    --test-tags '/<module>:TestFoo'
    --test-tags '/<module>:TestFoo.test_bar'
```

Rules:

- Always foreground: never use `&` with `--stop-after-init`.
- `--test-enable` always comes with an explicit `--test-tags`. On a fresh DB a bare
  `--test-enable` also runs the tests of every newly installed dependency (account, mail,
  sale…), which takes >10 minutes. Install first with `--stop-after-init` only, then run
  the test gate with `-u`.
- Tag forms: `/module`, `:Class`, `:Class.method`, `-tag` to exclude. `/test_file.py` and
  a bare `post_install` do not match.
- A test only runs if the module is installed in that DB:
  `psql -d <db> -c "SELECT state FROM ir_module_module WHERE name='<module>'"`.
- Quick syntax gate before any run: `~/src/odoo/.venv/bin/python -m py_compile <file>`.
- A change to addon code, JS, SCSS, templates or `ir.asset`/`ir.ui.view` data needs a
  server restart on the served DB; `-u` alone leaves stale assets.
- Servers: start one only inside your own session and record its pid
  (`nohup ... & echo $! > ~/src/odoo/log/server.pid`); stop it with
  `kill "$(cat ~/src/odoo/log/server.pid)"`. Never `pkill -f`/`killall`: your shell's own
  command line matches the pattern, and servers started outside this sandbox are invisible
  to you. If a port is busy and no pid file is yours, use another `--http-port` or report it.
- `--dev=reload,xml` is for interactive iteration only, never in a test gate.

## Reading results

Read only the log of the run you just made (fresh file, see "Command template"); a log with
more than one run is invalid: delete it and re-run. Never report green from a run with
N = 0, from a different tag spec than the gate, or from a log you did not read.

1. `grep odoo.tests.result <log>` must show exactly one line, `0 failed, 0 error(s) of N tests`
   with **N > 0**. Ignore `odoo.tests.stats`. Several result lines mean the log is stale or
   mixed; do not guess which one is current, re-run on a clean log.
2. N = 0 means a wrong tag spec or an uninstalled module. It still exits 0 and is a failure
   of the run, not a pass.
3. `grep -E 'ERROR|Traceback' <log>`: there must be none from your module. Failures exit 1,
   so also check the exit code of the command.
4. Benign noise: `collation version mismatch`, `markdown2 is not installed`.

On a failure, read the `FAIL:` / `ERROR:` block first: the test's own message comes before the
traceback. Act on what it points to before forming your own hypothesis.

## Writing tests that diagnose (core rule)

When a test fails you see only its output. A failure like `False is not true` costs a round
of guessing; one that names the method, field, expected value and likely cause saves it.
Every test you write must be diagnosable from its failure alone. Tests are how you learn what
is wrong with your own module: write them for the behaviour the task's requirements describe,
not for every line of code.
This complements `tests.md` (base classes, tags, silent skips, assert behaviour not
implementation), which says nothing about failure messages; the hint lives in the message,
never in the assertion logic.

### Message contract

Every assertion that can fail carries a `msg` with, in order:

1. **Scenario**: the action and the key inputs.
2. **Expected vs actual**: both values, plus the record (`display_name` / `model(id)`).
3. **Look at**: the `Model.method` or field that computes or enforces it, plus any
   `@api.depends`, `@api.constrains`, ACL line, record rule or view XML id involved.
4. **Likely cause**: one line (e.g. "`@api.depends` misses `line_ids.price_subtotal`",
   "record rule filters by company", "default not set in `create`").

```python
self.assertEqual(
    order.amount_total, 120.0,
    f"Confirm {order.display_name} with 2 lines of 60.0: expected amount_total=120.0, "
    f"got {order.amount_total}. Look at: sale.order._compute_amount_total and its "
    f"@api.depends (does it include 'line_ids.price_subtotal'?). "
    f"Likely: stale compute after a line write, or tax applied twice.",
)
```

Honesty rules:

- Name only suspects you verified exist (`grep` the method/field first). A wrong hint is
  worse than none; if you cannot name a real suspect, give scenario + expected vs actual.
- If a run proves a hint wrong, fix the hint in the same change; update hints when you
  rename or move the code they point to.

### Structure

- Build the scenario in `setUpClass` and keep its values in named variables, so messages can
  interpolate them.
- One behaviour per method, named `test_<model>_<action>_<expected>`: the name is already
  half the diagnosis.
- Several fields on several records: `assertRecordValues(records, [...])`. It prints a
  per-field diff but **takes no `msg`**, so wrap it in a helper that re-raises with the
  method/field to inspect appended to the failure.
- Multiple inputs: `with self.subTest(case=...)`, so one bad case does not hide the rest.
- Expected errors: `assertRaisesRegex(ValidationError, "<key phrase>")` plus `mute_logger`
  where it logs, so a wrong exception type or message fails differently from "nothing
  raised". Use `self.cr.savepoint()` when the transaction continues afterwards.
- Access: assert with a concrete user and operation, and name the ACL line or record rule:

  ```python
  with self.assertRaises(AccessError, msg=(
      f"{self.user_b.login} must not read {rec.display_name}: expected AccessError. "
      f"Look at: ir.model.access.csv line for {rec._name} and record rule <xmlid>. "
      f"Likely: rule domain too permissive or group missing.")):
      rec.with_user(self.user_b).read(['name'])
  ```
- Compute/onchange/constraint tests assert the *trigger*, not just the end state: change the
  dependency, then check the result, so a missing `@api.depends` is caught.
- No vacuous passes: assert a recordset is non-empty before looping over it.

### Fix discipline

- Iterate on the single failing method, then run the full module gate once.
- Decide what a failure says before changing anything: the code does not meet the requirement
  (fix the code), the test asserts something the requirement does not state (fix the test and
  name the requirement in the commit message), or the requirement is ambiguous (record the
  interpretation under Assumptions in the requirements file). Never change an expectation just
  to get green.
- A second failed fix attempt is a stop sign: re-read the guideline section and the 20.0
  source, then change approach instead of trying another blind variation.

## Autonomous operation (long sessions, minimal human review)

The human reviews only the final result and expects it to meet the original requirements.
Time is not a constraint, thoroughness is: spend it on verification, not on asking.

### Do not stop to ask
- Resolve ambiguity yourself: pick the interpretation closest to the stated requirement and
  Odoo conventions (skills, then 20.0 source) and state it as an assumption in the final
  report. Never ask the human questions or request approval: you cannot hand the turn back,
  and the human checks in on the session themselves.
- If something truly blocks a requirement (missing credentials, contradictory requirements),
  note exactly what blocks you and what you tried, try another approach, and keep working on
  the rest. Task size, time and "missing infrastructure" are never blockers (see "Finishing").
  Never act on `pouet` to get around it.

### Task requirements
For a larger task the human has you use the `odoo-task-requirements` skill: load it first and
write `~/src/odoo/log/<task>_requirements.md` before any code, then update it on every
follow-up prompt. The review gate below needs that file. If it does not exist when you try to
finish, the gate does not run: tell the human plainly in your final message that the
requirements file was missing and the work was not reviewed, and stop.

### Finishing: the review gate
When you try to finish after editing code or writing a requirements file, the
`require-review-gate` extension holds the turn open until you have reviewed your own work with
the `odoo-review` skill against your requirements file and fixed what the review found. Its
message gives the exact steps and the report format (`~/src/odoo/log/<task>_review.md`). It
opens with the task state read from the requirements file, the report and git, and ends with
next steps in priority order; any compaction of the session is followed by the same state, so
resume from it and from the files, not from the summary. The bar: every MUST requirement met,
at least 90% of all requirements met, at least 90% of the findings fixed with a commit that
exists. Run each requirement's Check fresh; a weakened test, relaxed threshold or shortfall is
a finding even if you think it is justified.

There is no time limit and no missing infrastructure: everything you need is described in this
file. A feeling that the task is too large, or that a tool or environment is missing, is a
sign of a long context, not a blocker: re-read the requirements file, take the next step on
the list, and keep going.

Before you try to finish, have these done, since the review will find them otherwise:
- A fresh install on a new test DB (`-i <module> --without-demo`) and a `-u` on a DB that
  already has the module, both succeeding (also with demo data if the module ships demo).
- The full module suite green with N > 0 (see "Reading results"), after your last code
  change; no `ERROR` / `Traceback` / unexpected `WARNING` from your module in the logs.
- `git status` clean apart from intended changes: commit them, remove debug code and stray
  files.
- For UI tasks: the browser test ran and every screenshot was inspected with
  `describe_screenshot` ("Browser tests"). A green browser test alone never satisfies this.

Your review must also cover these, which the guidelines do not spell out:
- Negative cases: wrong user/group, empty or multi-record sets, multi-company, archived
  records, duplicate or invalid input, cancel/reopen flows.
- Access: new models without ACL rows, `sudo()` without justification, record rules that
  leak across companies, public methods callable by users who should not.
- Data and upgrade: new required fields without defaults on existing records, `-u` on a
  populated DB, XML ids stable and unique.

### Never game the result
- Never weaken, delete, skip or `expectedFailure` a test to get green. Changing an expected
  value needs a requirement-based reason in the commit message.
- Never widen a regex, catch-all `except` or loosen an access rule just to make a test pass.
- Never mark a finding `fixed` without a run you saw pass this session.
- Report faithfully: if something is not done or not verified, say so in the final report;
  a smaller honest result beats a larger unverified one.

### Final report (what the human reads)
Keep it short and evidence-based:
1. Outcome vs the original task in one paragraph, with the review score (e.g.
   `9/10 findings fixed, 1 flagged`).
2. The task's requirements, each with its test name and evidence.
3. Assumptions made and decisions taken (each with the reason).
4. Gate evidence: commit hash, exact commands, `odoo.tests.result` line with N, log paths.
5. Known gaps, risks and anything that needs a human decision.

## Browser tests (screenshots): always capture, always inspect

Required: `websocket-client` (`uv pip install --python ~/src/odoo/.venv/bin/python websocket-client`, otherwise
`ChromeBrowser` raises `SkipTest` and the test silently passes) and `ODOO_BROWSER_BIN` set to
the Chromium path in "Environment" (the snap `current` symlink; never a numbered revision
path). If the binary is missing (`ls` fails), report it as a blocker; do not guess another path.

Run browser tests as their **own command with a hard class/method selection**, separate from
the normal unit-test run, on a test DB (never `pouet`):

```bash
ODOO_BROWSER_BIN=/snap/chromium/current/usr/lib/chromium-browser/chrome ~/src/odoo/.venv/bin/python ~/src/odoo/odoo/odoo-bin \
  --config=~/src/odoo/config/odoo.conf -d test_<module> -u <module> --test-enable \
  --test-tags ':Test<Module>Visual' --stop-after-init \
  --logfile=~/src/odoo/log/test_visual_<module>.log
```

Exclude the visual class from the normal run (`--test-tags '/<module>,-:Test<Module>Visual'`)
so the two never mix. Keep the class `post_install`; an `HttpCase` must not be `at_install`.

Odoo only saves screenshots on failure; to capture on pass, build the `ChromeBrowser`
yourself instead of `start_tour` / `browser_js`:

```python
from odoo.tests.common import HttpCase, ChromeBrowser
from odoo.tests import tagged

@tagged('post_install', '-at_install')
class Test<Module>Visual(HttpCase):
    browser_size = "1440,2400"   # set before the browser is built

    def test_<page>_screenshot(self):
        browser = ChromeBrowser(self, headless=True)
        self.addCleanup(browser.stop)          # a bare browser.cleanup leaks the process
        with self.allow_requests(browser=browser):
            self.authenticate("admin", "admin", browser=browser)
            url = f"{self.base_url()}/web?db={self.env.cr.dbname}#action=<module>.<action_xmlid>"
            browser.navigate_to(url, wait_stop=True)

            # Wait for rendered content, never a fixed sleep or readyState.
            browser._websocket_request("Runtime.evaluate", params={
                "expression": """
                    new Promise(resolve => {
                        const check = () => {
                            if (document.querySelector('.o_list_view, .o_kanban_view, .o_form_view')
                                && !document.querySelector('.o_loading_indicator')) {
                                resolve(true);
                            } else {
                                requestAnimationFrame(check);
                            }
                        };
                        requestAnimationFrame(check);
                    });
                """,
                "awaitPromise": True,
            }, timeout=30)

            browser.take_screenshot("<page>_")   # prefix must match \w*_
```

Never hardcode host, port or DB in the URL. The `/web?db=…#action=` form is the one that
honours the hash.

**The screenshot is the verification, not the test result.** These tests pass whenever the
page loads, so green says nothing about the UI. A UI requirement is verified only when
`describe_screenshot` has inspected the image and *you* have judged its report against the
requirement. A blank page, error dialog, missing data, wrong view or broken layout is a
failed requirement even with a green test.
For each UI requirement keep the PNG path plus a one-sentence description of what you saw
(for example "list shows 3 rows, column Total = 120.00, no error banner"); it is not
verified until you have written it. Capture the states that matter
(populated, empty, an error or warning state, the relevant form/kanban/list), not just the
happy default. If the image contradicts the requirement, fix the code and re-capture.

**Inspect every generated PNG** under `/tmp/odoo_tests/<db>/screenshots/` with the
`describe_screenshot` tool, one call per image (never open screenshots with `read`).

- `path`: the PNG. `question`: the requirement stated checkably, e.g. "Is this the Sales
  Orders list with columns Number, Customer, Total, 3 rows, Total = 120.00 each, and no
  error banner?". A vague question gives a vague answer.
- Read the whole report: **Observations**, **Problems seen**, **Answer** (YES/NO/UNCLEAR).
  `NO`, `UNCLEAR`, or any entry under Problems seen means the requirement is not verified:
  fix and re-capture, or re-ask with a sharper question, or capture the missing state.
- The report is a model's reading and can be wrong. If it contradicts the test or the code,
  re-ask with a narrower question rather than trusting either blindly. Never edit a report.
- The tool saves each report as `<png>.vision.md` next to the image. Put that path and the
  one-sentence Answer summary in the final report.
- If the tool fails for every model, it says so: report a blocker. Do not treat UI
  requirements as verified and do not describe the screenshot from imagination or from the test output.
- Confirm the expected view rendered: not blank, not a "Bad Request" or error page, correct
  view and data. A file existing proves nothing. Do not move or rename screenshots.
