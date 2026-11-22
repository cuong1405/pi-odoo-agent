---
name: odoo-browser-tests
description: >-
  Browser tests and screenshot verification for Odoo UI requirements: capture a screenshot
  with ChromeBrowser, inspect it with describe_screenshot, and record the evidence. Use when
  a task has any UI requirement (a view, list, form, kanban, dialog, report layout).
---

# Browser tests: always capture, always inspect

A green browser test only says the page loaded. The screenshot is the verification, so a UI
requirement is verified only when `describe_screenshot` has inspected the image and *you*
have judged its report against the requirement.

## Setup

Required: `websocket-client` (`uv pip install --python ~/src/odoo/.venv/bin/python
websocket-client`; without it `ChromeBrowser` raises `SkipTest` and the test silently passes)
and `ODOO_BROWSER_BIN=/snap/chromium/current/usr/lib/chromium-browser/chrome` (the snap
`current` symlink, never a numbered revision path). If the binary is missing (`ls` fails),
report a blocker; do not guess another path.

Run browser tests as their **own command with a hard class selection**, separate from the
unit-test run, on a test DB (never `pouet`):

```bash
ODOO_BROWSER_BIN=/snap/chromium/current/usr/lib/chromium-browser/chrome ~/src/odoo/.venv/bin/python ~/src/odoo/odoo/odoo-bin \
  --config=~/src/odoo/config/odoo.conf -d test_<module> -u <module> --test-enable \
  --test-tags ':Test<Module>Visual' --stop-after-init \
  --logfile=~/src/odoo/log/test_visual_<module>.log
```

Exclude the visual class from the normal run (`--test-tags '/<module>,-:Test<Module>Visual'`)
so the two never mix. Keep the class `post_install`; an `HttpCase` must not be `at_install`.

## Capture

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

Never hardcode host, port or DB in the URL. The `/web?db=...#action=` form is the one that
honours the hash. Capture the states that matter (populated, empty, an error or warning
state, the relevant form, list or kanban), not just the happy default. Screenshots land in
`/tmp/odoo_tests/<db>/screenshots/`; do not move or rename them.

## Inspect

Inspect **every** generated PNG with the `describe_screenshot` tool, one call per image
(never open screenshots with `read`).

- `path`: the PNG. `question`: the requirement stated checkably, for example "Is this the
  Sales Orders list with columns Number, Customer, Total, 3 rows, Total = 120.00 each, and no
  error banner?". A vague question gives a vague answer.
- Read the whole report: **Observations**, **Problems seen**, **Answer** (YES/NO/UNCLEAR).
  `NO`, `UNCLEAR`, or any entry under Problems seen means the requirement is not verified:
  fix and re-capture, re-ask with a sharper question, or capture the missing state.
- The report is a model's reading and can be wrong. If it contradicts the test or the code,
  re-ask with a narrower question rather than trusting either blindly. Never edit a report.
- Confirm the expected view rendered: not blank, not a "Bad Request" or error page, correct
  view and data. A file existing proves nothing.
- The tool saves each report as `<png>.vision.md` next to the image. Put that path and the
  one-sentence Answer in the requirement's Evidence cell. If the tool fails for every model it
  says so: report a blocker, and do not describe a screenshot from imagination or from the
  test output.
- If the image contradicts the requirement, fix the code and re-capture.
