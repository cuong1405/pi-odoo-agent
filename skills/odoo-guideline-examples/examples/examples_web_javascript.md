# Examples: Web: JavaScript

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-web-guidelines/guidelines/javascript.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Organize files by feature, not by type

Guideline: [Organize files by feature, not by type](../../odoo-web-guidelines/guidelines/javascript.md#organize-files-by-feature-not-by-type). Rule: One folder per feature holding its component, template and styles.

**Layout** `addons/crm/static/src/components/team_switcher/`: `team_switcher/` holds the component and its template together.

```
team_switcher.js
team_switcher.xml
```


## End a sort comparator on a unique key

Guideline: [End a sort comparator on a unique key](../../odoo-web-guidelines/guidelines/javascript.md#end-a-sort-comparator-on-a-unique-key). Rule: A comparator that can see equal values ends on a unique key, usually `id`.

**Good** `addons/mail/static/src/core/web/activity_list_popover.js:38`: Comparator ends with `|| a.id - b.id`.

```js
            .sort((a, b) => compareDatetime(a.date_deadline, b.date_deadline) || a.id - b.id);
```

**Violation** `addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:178-180`: `a.sequence - b.sequence`: two elements with the same sequence keep an unstable order. Fix: `|| a.id - b.id` when items carry an id.

```js
    get sortedDropdownContentElements() {
        return this.state.dropdownContentElements.toSorted((a, b) => a.sequence - b.sequence)
    }
```


## Avoid getters

Guideline: [Avoid getters](../../odoo-web-guidelines/guidelines/javascript.md#avoid-getters). Rule: Write a plain function (or an Owl `computed`) instead of a getter.

**Violation** `addons/crm/static/src/components/team_switcher/team_switcher.js:25-43`: Five getters: each hides a computation behind a property read.

```js
    get allTeamsLabel() {
        return _t("All Teams");
    }

    get currentLabel() {
        return this.teams.find((t) => t.id === this.selectedTeamId)?.name || this.allTeamsLabel;
    }

    get hasDropdown() {
        return this.teams.length > 0;
    }

    get selectedTeamId() {
        return this.env.searchModel.state.switcherTeamId;
    }

    get teams() {
        return this.env.searchModel.state.switcherTeams;
    }
```


## Avoid patching JavaScript code

Guideline: [Avoid patching JavaScript code](../../odoo-web-guidelines/guidelines/javascript.md#avoid-patching-javascript-code). Rule: `patch` is strongly discouraged inside Odoo; design an extension point instead.

**Violation** `addons/crm/static/src/activity_menu_patch.js:1-6`: `patch(ActivityMenu.prototype, ...)` in core code.

```js
import { Domain } from "@web/core/domain";
import { ActivityMenu } from "@mail/core/web/activity_menu";
import { patch } from "@web/core/utils/patch";

patch(ActivityMenu.prototype, {
    availableViews(group) {
```


## Use `window` members directly, not the `browser` object

Guideline: [Use `window` members directly, not the `browser` object](../../odoo-web-guidelines/guidelines/javascript.md#use-window-members-directly-not-the-browser-object). Rule: Write `localStorage`, `setTimeout`... without the `browser.` prefix; only `location` is imported from `@web/core/browser/browser`.

**Violation** `addons/crm/static/src/views/crm_search_model.js:153`: `browser.localStorage.getItem(...)`. Fix: `localStorage.getItem(...)`, and drop the import.

```js
        let teamId = JSON.parse(browser.localStorage.getItem("crm.switcher_team_id"));
```

**Violation** `addons/crm/static/src/views/crm_search_model.js:1`: The `browser` import that goes with it.

```js
import { browser } from "@web/core/browser/browser";
```
