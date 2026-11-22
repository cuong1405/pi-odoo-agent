# Examples: Web: tests

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-web-guidelines/guidelines/tests.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Pair every absence check with a positive one

Guideline: [Pair every absence check with a positive one](../../odoo-web-guidelines/guidelines/tests.md#pair-every-absence-check-with-a-positive-one). Rule: An absence check (`toHaveCount(0)`) follows a positive check on an element only the state under test produces.

**Good** `addons/crm/static/tests/crm_rainbowman.test.js:350-352`: Positive check (`toHaveCount(1)`) on the element the step produces.

```js
    await contains("button.o_form_button_save").click();
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(1);
    expect.verifySteps(["You just beat your personal record for the past 7 days."]);
```

**Violation** `addons/crm/static/tests/crm_rainbowman.test.js:362-365`: `toHaveCount(0)` right after the click, with no positive check on the same element before it: it passes on a renamed selector.

```js
    await contains(".o_statusbar_status button[data-value='2']").click();
    await contains("button.o_form_button_save").click();
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(0);
    expect.verifySteps(["no rainbowman"]);
```


## Freeze the time when a test meets a timer

Guideline: [Freeze the time when a test meets a timer](../../odoo-web-guidelines/guidelines/tests.md#freeze-the-time-when-a-test-meets-a-timer). Rule: A Hoot test that triggers a debounced or delayed call calls `freezeTime()` then `advanceTime`.

**Good** `addons/mail/static/tests/discuss/call/call_surface_stability.test.js:645-646`: `freezeTime()` before the action that meets a timer.

```js
    // Frozen, `requestAnimationFrame` stops firing too, hence the `advanceFrame` calls.
    freezeTime();
```
