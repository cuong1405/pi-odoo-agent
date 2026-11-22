#!/usr/bin/env python3
"""Build skills/odoo-guideline-examples/ from the Odoo source.

Every code block of the examples is copied verbatim from `git show <COMMIT>:<path>` of an Odoo
checkout, so a snippet cannot drift from the source or be mistyped. What is curated by hand is
the table below: for each guideline section, which file and line range of that commit shows the
rule followed (good) or broken (bad). Line numbers belong to COMMIT; to refresh the examples for a
newer commit, update COMMIT and re-check each range (the script fails loudly on a range past the
end of a file, and prints each snippet's first line so a moved range is easy to spot).

    python3 tools/build_guideline_examples.py [--odoo ~/src/odoo/odoo]

The guideline sections come from the `skills/` directory of the same checkout; the script reads
the heading and the first sentence of each section from there to check that the title still exists.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

COMMIT = "530bc2789e2"
OUT = Path(__file__).resolve().parent.parent / "skills" / "odoo-guideline-examples"

# kind: good | bad | note (observed, neither clean nor a clear violation) | tree. Paths are relative to the root of the odoo repository.
# (kind, path, first line, last line, note)  -- for "tree": (kind, directory, None, None, note)
G, B, T, N = "good", "bad", "tree", "note"

# file -> (title, guideline domain file, [(section title, guideline anchor, rule in one line, [entries])])
SPEC: dict[str, tuple[str, str, list]] = {
    "examples_architecture.md": ("Architecture", "odoo-guidelines/guidelines/architecture.md", [
        ("Put code in the module that owns its concern", "put-code-in-the-module-that-owns-its-concern",
         "A feature that connects two apps goes in a bridge module that depends on both and is auto_install.",
         [(G, "addons/sale_crm/__manifest__.py", 17, 27,
           "`sale_crm` connects the sale and crm apps: depends on both, `auto_install` so it is installed exactly when both are.")]),
    ]),
    "examples_module_structure.md": ("Module structure", "odoo-guidelines/guidelines/module_structure.md", [
        ("Module structure and file naming", "module-structure-and-file-naming",
         "Standard directories, one model class per file named after the model, suffix conventions.",
         [(T, "addons/crm/wizard", None, None, "Wizard: `<transient>.py` + `<transient>_views.xml`."),
          (T, "addons/crm/report", None, None, "Statistics (SQL view) report: `<model>_report.py` + `<model>_report_views.xml` (here `crm_activity_report`)."),
          (T, "addons/crm/security", None, None, "Access rows in `ir.access.csv`, groups in `<module>_security.xml`."),
          (B, "addons/crm/models/crm_lead_scoring_frequency.py", 7, 20,
           "Two model classes in one file: each model gets its own file named after it."),
          (T, "addons/crm/controllers", None, None, "`main.py` is the legacy controller name; prefer a feature name, or `<inherited_module>.py` when extending.")]),
    ]),
    "examples_manifest.md": ("Manifest", "odoo-guidelines/guidelines/manifest.md", [
        ("Manifest", "manifest",
         "Direct dependencies only (never `base`), correct license, `application` only for full apps, assets declared in the manifest.",
         [(G, "addons/crm/__manifest__.py", 1, 23,
           "`depends` lists direct dependencies and not `base`."),
          (G, "addons/crm/__manifest__.py", 64, 71,
           "`demo` files are separate from `data`; `application` is True because crm is a full app."),
          (G, "addons/crm/__manifest__.py", 97, 108,
           "Test assets declared in the manifest `assets` key, and the license set deliberately.")]),
    ]),
    "examples_python.md": ("Python: imports, naming, translation", "odoo-guidelines/guidelines/python.md", [
        ("Imports", "imports",
         "Four groups, each alphabetically sorted: stdlib, third-party, `odoo`, `odoo.addons.*`.",
         [(G, "addons/crm/models/crm_stage.py", 1, 5, "`odoo` group sorted."),
          (B, "addons/crm/models/crm_lead.py", 3, 21,
           "`odoo.addons.*` imports sit between `odoo` imports, `odoo.tools.translate` comes before `odoo.tools`, and the import of `_` is the bare legacy form."),
          (B, "addons/crm/models/crm_team_member.py", 4, 9,
           "`from ast import literal_eval` is split from the other stdlib imports by a blank line, and `_` comes last in the `odoo` import where the ruff isort order puts it first.")]),
        ("Naming and model layout", "naming-and-model-layout",
         "Dotted singular `_name`; method-name patterns (`_compute_*`, `_default_*`, `action_*`); private attributes first, then fields, then constraints and indexes, then computes, CRUD overrides, actions.",
         [(G, "addons/crm/models/crm_lead.py", 84, 100, "Private attributes (`_name`, `_description`, `_order`, `_inherit`) open the model."),
          (G, "addons/crm/models/crm_lead.py", 249, 255, "`models.Constraint` / `models.Index` attributes follow the fields; the attribute names start with `_`."),
          (G, "addons/crm/models/crm_lead.py", 388, 392, "Compute method named `_compute_<field>` with `@api.depends` (the translated string in it is a violation, see below).")]),
        ("Translate only static literals", "translate-only-static-literals",
         "Pass values as arguments of the lookup, never format before or after it; use `self.env._` in model code.",
         [(G, "addons/crm/models/crm_lead.py", 935, 935, "Interpolation value passed as an argument of `_()`."),
          (G, "addons/account/models/account_reconcile_model.py", 179, 181, "`self.env._(...)` with a static literal, the current API."),
          (G, "addons/account_edi_ubl_cii/models/account_edi_common.py", 1537, 1537, "`self.env._` with a value argument."),
          (B, "addons/crm/models/crm_lead.py", 392, 392, "Formats with `%` after the lookup: bypasses placeholder validation. Fix: `self.env._(\"%s's opportunity\", lead.partner_id.name)`."),
          (B, "addons/crm/models/crm_lead.py", 17, 17, "The bare `_` import is the backward-compatible API; prefer `self.env._`.")]),
    ]),
    "examples_orm.md": ("ORM", "odoo-guidelines/guidelines/orm.md", [
        ("Recordsets, domains and context", "recordsets-domains-and-context",
         "Combine domains with `odoo.fields.Domain`; never hand-build `'&'`/`'|'` prefix lists.",
         [(G, "addons/crm/models/crm_team.py", 458, 465, "`Domain.AND([...])` and `&=` with `Domain(...)`."),
          (G, "addons/crm/models/crm_stage.py", 39, 42, "Inline domains combined with the `|` operator."),
          (B, "addons/crm/models/crm_team.py", 205, 208, "Hand-built prefix notation `'&', '|', ...`. Fix: combine `Domain` objects with `&` and `|`."),
          (B, "addons/crm/models/crm_lead.py", 1017, 1020, "Hand-built `['|', ...]` list for a domain that is then extended.")]),
        ("Computes, onchange and constraints", "computes-onchange-and-constraints",
         "`@api.model_create_multi` for `create`; SQL constraints and indexes as model attributes (`models.Constraint`, `models.Index`), never `_sql_constraints`.",
         [(G, "addons/crm/models/crm_lead.py", 728, 733, "`create` takes `vals_list` and is decorated with `@api.model_create_multi`."),
          (G, "addons/crm/models/crm_lead.py", 249, 255, "`models.Constraint` and `models.Index` attributes.")]),
        ("End `_order` on a unique field", "end-_order-on-a-unique-field",
         "A model's `_order` ends with a unique field, usually `id`.",
         [(G, "addons/crm/models/crm_stage.py", 25, 25, "`_order = \"sequence, name, id\"`."),
          (G, "addons/crm/models/crm_lead.py", 88, 88, "`_order = \"priority desc, id desc\"`: `id desc` after a `desc` term."),
          (B, "addons/crm/models/crm_recurring_plan.py", 8, 16, "`_order = \"sequence\"`: two plans with the same sequence come back in any order. Fix: `\"sequence, id\"`.")]),
        ("Set a state, never flip it", "set-a-state-never-flip-it",
         "A method sets a fixed state; a state that goes both ways gets one method per direction.",
         [(G, "addons/crm/models/crm_lead.py", 1051, 1059, "`action_set_lost` and `action_set_won` set a fixed state (archive / unarchive plus the probability), never a flip."),
          (G, "addons/hr_recruitment/models/hr_applicant.py", 1117, 1123, "`action_archive` / `action_unarchive`: one method per direction."),
          (B, "addons/delivery/models/delivery_carrier.py", 231, 237, "`toggle_prod_environment` and `toggle_debug` read the current value to write its opposite. Fix: one method per direction, or a method taking the state to reach.")]),
        ("Methods and extension points", "methods-and-extension-points",
         "Logic another module overrides goes in its own small private method; public names are RPC entry points.",
         [(G, "addons/crm/models/crm_lead.py", 382, 386, "`_get_rotting_domain` is a small private hook that the model extends with `super()` and a `Domain`.")]),
        ("Transactions and exceptions", "transactions-and-exceptions",
         "Never `cr.commit()` unless you own the cursor, and justify an unavoidable one; catch specific exceptions over the smallest block.",
         [(B, "addons/crm/models/crm_team.py", 106, 114, "`except Exception` around a domain search: catch the specific exceptions the call raises, over the smallest block."),
          (N, "addons/crm/models/crm_lead.py", 2459, 2466, "A batched job that commits the framework's cursor with a short comment and swallows `Exception`. A commit on the framework cursor needs a comment that justifies why it is unavoidable, and an `except Exception` should name what it expects."),
          (N, "addons/crm/models/crm_team.py", 554, 556, "A `cr.commit()` helper with no comment saying why it is unavoidable. Do not add one like it; if a commit is unavoidable, say why next to it.")]),
    ]),
    "examples_fields.md": ("Fields", "odoo-guidelines/guidelines/fields.md", [
        ("Fields", "fields",
         "`_id` / `_ids` suffixes, selective indexes (`btree_not_null` for fields empty on most rows, `trigram` for `like`), `groups` on sensitive fields.",
         [(G, "addons/crm/models/crm_lead.py", 183, 188, "`index='btree_not_null'` on a field searched for exact values and empty on most rows."),
          (G, "addons/crm/models/crm_lead.py", 104, 106, "`index='trigram'` on a field searched with `like`."),
          (B, "addons/crm/models/crm_lead.py", 146, 146, "Many2one `recurring_plan` without the `_id` suffix. Fix: `recurring_plan_id`."),
          (B, "addons/crm/models/crm_lead.py", 153, 153, "Many2one `company_currency` without the `_id` suffix. Fix: `company_currency_id`.")]),
    ]),
    "examples_controllers.md": ("Controllers", "odoo-guidelines/guidelines/controllers.md", [
        ("Controllers", "controllers",
         "`@route` on every route with the right `auth`; re-decorate an override with `@route`.",
         [(G, "addons/crm/controllers/main.py", 11, 14, "`@http.route` with an explicit `type`, `auth` and `methods`.")]),
    ]),
    "examples_xml.md": ("XML views, actions and data", "odoo-guidelines/guidelines/xml.md", [
        ("Views, actions and data records", "views-actions-and-data-records",
         "`id` before `model` on a record; `<odoo noupdate=\"1\">` instead of `<data noupdate=\"1\">` when the whole file is noupdate; xml id patterns `<model>_view_<type>`; prefer `<menuitem>`.",
         [(G, "addons/crm/views/crm_lead_views.xml", 3, 5, "`<record id=... model=...>`: `id` first."),
          (B, "addons/crm/views/crm_lead_views.xml", 1018, 1022, "`<record model=... id=...>`: `id` must come before `model`."),
          (G, "addons/crm/data/crm_stage_data.xml", 1, 2, "Whole file is noupdate: `noupdate=\"1\"` on `<odoo>`."),
          (B, "addons/crm/data/crm_team_data.xml", 1, 2, "`<odoo><data noupdate=\"1\">` for a file that is entirely noupdate: set it on `<odoo>` and drop `<data>`."),
          (G, "addons/crm/views/crm_menu_views.xml", 9, 14, "`<menuitem>` sugar tag instead of a raw `ir.ui.menu` record."),
          (G, "addons/crm/views/crm_lead_views.xml", 3, 3, "View id `<model>_view_<type>` pattern: `crm_lead_view_form`."),
          (G, "addons/crm/views/crm_team_views.xml", 123, 127, "An inheriting view reuses the id of the original record (`crm_team_view_tree`) and its `name` carries the `.inherit.<details>` suffix.")]),
        ("Anchor view inheritance on names, never on position", "anchor-view-inheritance-on-names-never-on-position",
         "Anchor on a stable `name`; never on document position.",
         [(G, "addons/crm/views/crm_team_views.xml", 128, 130, "Shorthand form: matches the field by name."),
          (G, "addons/crm/views/crm_team_views.xml", 180, 183, "xpath anchored on `@name`."),
          (B, "addons/crm/views/crm_team_views.xml", 140, 140, "`//form/*[1]` anchors on position: breaks when the parent view reorders. Fix: anchor on a named element of the parent.")]),
    ]),
    "examples_reports.md": ("QWeb reports", "odoo-guidelines/guidelines/reports.md", [
        ("QWeb PDF reports", "qweb-pdf-reports",
         "A custom `_get_report_values` adds `docs` / `doc_ids` / `doc_model` itself.",
         [(G, "addons/account/report/account_invoice_report.py", 162, 178, "`_get_report_values` returns `doc_ids`, `doc_model` and `docs` itself.")]),
    ]),
    "examples_security.md": ("Access rights", "odoo-guidelines/guidelines/security.md", [
        ("Access rights", "access-rights",
         "`ir.access.csv` rows: permissions with a group are OR-ed, group-less rows are restrictions on everyone; multi-company models need a group-less company restriction; never grant c/u/d to everyone, portal or public.",
         [(G, "addons/crm/security/ir.access.csv", 1, 5,
           "Permission rows with a group and an `operation` subset (`crud`, `cru`), a row restricted by `domain`, and the group-less multi-company restriction `crm_lead_company_rule` with `company_ids + [False]`.")]),
    ]),
    "examples_performance.md": ("Performance", "odoo-guidelines/guidelines/performance.md", [
        ("Batch ORM calls", "batch-orm-calls",
         "One ORM call for the whole collection; no `search`, `search_count`, `_read_group` or `create` inside a loop over records.",
         [(G, "addons/crm/models/crm_team.py", 77, 84, "One grouped `_read_group`, then a dict lookup per record."),
          (B, "addons/crm/wizard/crm_merge_opportunities.py", 46, 56, "`search_count` and `search` inside `for wizard in self`: one query per record."),
          (B, "addons/crm/models/crm_team.py", 140, 164, "`create` inside the loop over `frequencies`: collect the values and create once after the loop.")]),
        ("Use search_fetch when the domain and the rules are simple", "use-search_fetch-when-the-domain-and-the-rules-are-simple",
         "`search_fetch(domain, fields)` saves a query when the fields read are known.",
         [(G, "addons/account/models/account_analytic_account.py", 52, 59, "`search_fetch(..., ['move_id'])` then reads `move_id`.")]),
        ("Do not read an x2many that grows without bound", "do-not-read-an-x2many-that-grows-without-bound",
         "Do not read messages, followers, members or logs to count or test them; ask the comodel with `search_count(..., limit=...)`.",
         [(B, "addons/crm/models/crm_lead.py", 1117, 1119, "`len(self.message_ids) >= 25` loads every message id of the lead. Fix: ask `mail.message` with `search_count(..., limit=25)` using the domain of the `message_ids` field, as the guideline example does for `loan_ids`.")]),
    ]),
    "examples_tests.md": ("Tests", "odoo-guidelines/guidelines/tests.md", [
        ("Tests", "tests",
         "Tag exactly one of `at_install` / `post_install`; start from `BaseCommon`; build shared records in `setUpClass`; `assertQueryCount` only in dedicated performance tests; `mute_logger` for expected errors; every test file imported from `tests/__init__.py`.",
         [(G, "addons/crm/tests/test_crm_ui.py", 8, 9, "`@tagged('post_install', '-at_install')` on an `HttpCase`."),
          (B, "addons/crm/tests/test_digest.py", 12, 13, "`at_install` with only a `# LEGACY at_install` comment: the guideline asks for a comment that justifies why the test must run before other modules load."),
          (G, "addons/sales_team/tests/common.py", 1, 20, "A common test class built on `BaseCommon`, with shared records built once in `setUpClass`."),
          (G, "addons/crm/tests/test_performances.py", 57, 61, "`assertQueryCount` in a dedicated performance test, after a warmup."),
          (G, "addons/crm/tests/__init__.py", 1, 8, "Every test module is imported from `tests/__init__.py`; a file not imported here never runs.")]),
    ]),
    "examples_comments.md": ("Comments and messages", "odoo-guidelines/guidelines/comments.md", [
        ("Plain ASCII punctuation in comments and messages", "plain-ascii-punctuation-in-comments-and-messages",
         "ASCII punctuation only in comments, docstrings, user-facing strings and commit messages: no em dash, en dash, curly quotes or the ellipsis character.",
         [(B, "addons/crm/models/crm_lead.py", 1119, 1119, "Em dash in a translatable string. Fix: `'Phew, that took some effort, but you nailed it. Good job!'`."),
          (B, "addons/crm/models/crm_lead.py", 1181, 1181, "Curly apostrophe in a translatable string. Fix: `didn't`.")]),
    ]),
    "examples_web_javascript.md": ("Web: JavaScript", "odoo-web-guidelines/guidelines/javascript.md", [
        ("Organize files by feature, not by type", "organize-files-by-feature-not-by-type",
         "One folder per feature holding its component, template and styles.",
         [(T, "addons/crm/static/src/components/team_switcher", None, None, "`team_switcher/` holds the component and its template together.")]),
        ("End a sort comparator on a unique key", "end-a-sort-comparator-on-a-unique-key",
         "A comparator that can see equal values ends on a unique key, usually `id`.",
         [(G, "addons/mail/static/src/core/web/activity_list_popover.js", 38, 38, "Comparator ends with `|| a.id - b.id`."),
          (B, "addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js", 178, 180, "`a.sequence - b.sequence`: two elements with the same sequence keep an unstable order. Fix: `|| a.id - b.id` when items carry an id.")]),
        ("Avoid getters", "avoid-getters",
         "Write a plain function (or an Owl `computed`) instead of a getter.",
         [(B, "addons/crm/static/src/components/team_switcher/team_switcher.js", 25, 43, "Five getters: each hides a computation behind a property read.")]),
        ("Avoid patching JavaScript code", "avoid-patching-javascript-code",
         "`patch` is strongly discouraged inside Odoo; design an extension point instead.",
         [(B, "addons/crm/static/src/activity_menu_patch.js", 1, 6, "`patch(ActivityMenu.prototype, ...)` in core code.")]),
        ("Use `window` members directly, not the `browser` object", "use-window-members-directly-not-the-browser-object",
         "Write `localStorage`, `setTimeout`... without the `browser.` prefix; only `location` is imported from `@web/core/browser/browser`.",
         [(B, "addons/crm/static/src/views/crm_search_model.js", 153, 153, "`browser.localStorage.getItem(...)`. Fix: `localStorage.getItem(...)`, and drop the import."),
          (B, "addons/crm/static/src/views/crm_search_model.js", 1, 1, "The `browser` import that goes with it.")]),
    ]),
    "examples_web_templates.md": ("Web: templates", "odoo-web-guidelines/guidelines/templates.md", [
        ("Give every icon `role=\"img\"` and a label or `aria-hidden`", "give-every-icon-roleimg-and-a-label-or-aria-hidden",
         "An icon element carries `role=\"img\"` and `aria-hidden=\"true\"` (decorative) or an `aria-label`.",
         [(G, "addons/crm/views/utm_campaign_views.xml", 22, 22, "Icon with `role=\"img\"` and an `aria-label`."),
          (G, "addons/crm/views/crm_team_views.xml", 271, 271, "Icon with `role=\"img\"`, `aria-label` and `title`."),
          (B, "addons/crm/views/crm_lead_views.xml", 407, 407, "Icon with only a `title`: no `role=\"img\"`, no `aria-label` or `aria-hidden`."),
          (B, "addons/crm/views/crm_lead_templates.xml", 9, 9, "Decorative icon without `role=\"img\"` and `aria-hidden=\"true\"`.")]),
    ]),
    "examples_web_scss.md": ("Web: SCSS", "odoo-web-guidelines/guidelines/scss.md", [
        ("SCSS and CSS", "scss-and-css",
         "Prefix classes with `o_<module>`, no `id` selectors, flat class names, 4-space indent.",
         [(G, "addons/crm/static/src/scss/crm_team.scss", 1, 11, "`o_crm_...` prefixed, flat class names, 4-space indent."),
          (B, "addons/crm/static/src/scss/crm.scss", 1, 14, "`crm_lead_merge_summary`, `crm_quick_create_opportunity_form_group`, `crm_revenues`: classes without the `o_crm` prefix.")]),
    ]),
    "examples_web_tests.md": ("Web: tests", "odoo-web-guidelines/guidelines/tests.md", [
        ("Pair every absence check with a positive one", "pair-every-absence-check-with-a-positive-one",
         "An absence check (`toHaveCount(0)`) follows a positive check on an element only the state under test produces.",
         [(G, "addons/crm/static/tests/crm_rainbowman.test.js", 350, 352, "Positive check (`toHaveCount(1)`) on the element the step produces."),
          (B, "addons/crm/static/tests/crm_rainbowman.test.js", 362, 365, "`toHaveCount(0)` right after the click, with no positive check on the same element before it: it passes on a renamed selector.")]),
        ("Freeze the time when a test meets a timer", "freeze-the-time-when-a-test-meets-a-timer",
         "A Hoot test that triggers a debounced or delayed call calls `freezeTime()` then `advanceTime`.",
         [(G, "addons/mail/static/tests/discuss/call/call_surface_stability.test.js", 645, 646, "`freezeTime()` before the action that meets a timer.")]),
    ]),
}


def git_show(odoo: Path, path: str) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(odoo), "show", f"{COMMIT}:{path}"], capture_output=True, text=True, check=True
    ).stdout
    return out.splitlines()


def lang(path: str) -> str:
    return {"py": "python", "xml": "xml", "js": "js", "scss": "scss", "csv": "csv"}.get(path.rsplit(".", 1)[-1], "")


def render_entry(odoo: Path, entry) -> str:
    kind, path, a, b, note = entry
    if kind == T:
        names = subprocess.run(
            ["git", "-C", str(odoo), "ls-tree", "--name-only", f"{COMMIT}:{path}"],
            capture_output=True, text=True, check=True,
        ).stdout.split()
        names = [n for n in names if not n.endswith(".pyc") and n != "__pycache__"]
        return f"**Layout** `{path}/`: {note}\n\n```\n" + "\n".join(names) + "\n```\n"
    lines = git_show(odoo, path)
    if b > len(lines):
        sys.exit(f"{path}: range {a}-{b} is past the end ({len(lines)} lines)")
    body = "\n".join(lines[a - 1 : b])
    where = f"{path}:{a}" if a == b else f"{path}:{a}-{b}"
    label = {"good": "Good", "bad": "Violation", "note": "Observed"}[kind]
    print(f"  {kind:4} {where}: {lines[a - 1].strip()[:70]}")
    return f"**{label}** `{where}`: {note}\n\n```{lang(path)}\n{body}\n```\n"


def check_section(odoo: Path, domain_file: str, anchor: str, title: str) -> None:
    text = (odoo / "skills" / domain_file).read_text()
    plain = lambda s: re.sub(r"[^a-z0-9_ -]", "", s.lower()).strip().replace(" ", "-")
    anchors = [plain(h) for h in re.findall(r"^#\s+(.+)$", text, re.M)]
    if anchor not in anchors:
        print(f"  WARNING: section anchor '{anchor}' not found in {domain_file} (renamed or removed upstream?)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--odoo", default=str(Path.home() / "src" / "odoo" / "odoo"))
    odoo = Path(ap.parse_args().odoo)
    (OUT / "examples").mkdir(parents=True, exist_ok=True)
    for fname, (title, domain_file, sections) in SPEC.items():
        print(fname)
        skill = domain_file.split("/")[0]
        parts = [
            f"# Examples: {title}\n",
            f"Real Odoo 20.0 code (commit `{COMMIT}`) against `{domain_file}`, which you read whole "
            f"as well. **Good** follows the rule. **Violation** is upstream code that breaks it: "
            f"recognise the pattern, never copy it, never extend it. **Observed** is neither clean "
            f"nor a clear violation. How to read these examples: `../SKILL.md`.\n",
        ]
        for sec_title, anchor, rule, entries in sections:
            check_section(odoo, domain_file, anchor, sec_title)
            link = f"../../{domain_file}#{anchor}"
            parts.append(f"\n## {sec_title}\n\nGuideline: [{sec_title}]({link}). Rule: {rule}\n")
            for e in entries:
                parts.append(render_entry(odoo, e))
        (OUT / "examples" / fname).write_text("\n".join(parts).rstrip() + "\n")


if __name__ == "__main__":
    main()
