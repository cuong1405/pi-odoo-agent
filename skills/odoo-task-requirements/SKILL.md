---
name: odoo-task-requirements
description: >-
  Start of an Odoo task: map the prompt to the guideline sections that apply, read them,
  and write the task requirements file the final review is measured against. Use first,
  before any code, when the task is more than a one-line fix; and again whenever a
  follow-up prompt adds, changes or corrects a requirement.
---

# Task requirements

This skill is the first half of a pair. `odoo-review` runs at the end of every round and
judges the change against the house rules and on its merits; this skill runs once, at the very
start, and does the same two passes on the **prompt** before any code exists. It follows the
same process on purpose: where `odoo-review` maps changed files to guideline sections, this
skill maps the files the task will need; where the review hunts for the input that breaks a
hunk, this skill hunts for the input that breaks a requirement. The one difference is the
output: a requirements file, the only thing the final review (`odoo-review`, run by the review
gate) is checked against. A requirement that is not in the file is not reviewed, and the
review is recorded in the same file; there is no separate report.

The house rules live in the sibling skills, read fresh for every task:

| Sibling skill | Covers |
| --- | --- |
| `../odoo-guidelines/SKILL.md` | every file outside `static/`; its table maps file types to sections in `guidelines/` |
| `../odoo-web-guidelines/SKILL.md` | every file under `static/`: JavaScript, Owl templates, SCSS, hoot tests |
| `../odoo-security/SKILL.md` | controllers, `ir.access` rows, `sudo()`, raw SQL, `eval`, public or RPC-callable methods |
| `../odoo-guideline-examples/SKILL.md` | real Odoo code, good and bad, for each guideline section; its table maps a file type to an example file |

## Process

1. **Scope.** Read the whole prompt, then work in a local checkout. Pin the base commit and
   note the target branch (master or a stable version). Read each touched module's
   `__manifest__.py` for its purpose and `depends`, its existing code around the area, and
   its recent commits. Find the other half of the change: the sibling repository (enterprise
   for community, and the reverse). For a new module, the scope is its name and its `depends`.
2. **Map.** List every file or area the task will create or change (models, views, security,
   data, controllers, reports, tests, `static/`) with the guideline sections that apply to it,
   taken from the sibling tables, and with the example file of `odoo-guideline-examples` for
   that file type. For a new feature or module, the first row is the module that owns each
   part (the guidelines' architecture section), before any file. Every file maps to at least one section: Python always gets
   Imports and Naming, anything under `static/` gets the web guidelines, a `tests/` file gets
   Tests, security files and controllers get `odoo-security`, and a released Odoo version as
   the target adds the `odoo-stable-policy` skill. A file left without a section is a mapping mistake to
   fix, never a file without rules. Record the map in the file.
3. **Read.** Open every mapped section before writing the first row, and the mapped example
   files: the guidelines say what the rule is, the examples show real code that follows it and
   real code that breaks it. The files sit in the sibling folders and are short; `cat` them
   whole.
4. **Rules pass.** Go through the stated requirements against the sections read, then add a
   row for every requirement the rules impose that the prompt does not state. Typical ones:
   access rights (ACL rows and record rules for every new model, who must not read or
   write), views, actions and menus for new models, translatable user-facing strings, demo
   data (shipped in the manifest `demo` key; tests must not depend on it), an upgrade (`-u`)
   on a populated database, tests named for the behaviour they check. Add only what the task
   touches; an unrelated area is not a requirement.
5. **Merits pass.** The rules are the floor, not the ceiling. For every requirement, hunt for
   the input or state that makes it wrong, as the author's most sceptical colleague would:
   empty and multi-record calls, archived records, multi-company, the wrong user or group,
   rounding and timezones, concurrency, the second run, cancel and reopen, an upgrade of a
   populated database, the cost at scale. Check that the Check you write would fail without
   the change. Then look at **code the task will touch but the prompt never mentions**: for
   every existing method, field, view, template or key the task changes or extends, find its
   consumers and overrides across every addons path (`git grep`) and add a row for each that
   can break. Give this pass the same legwork as the rules pass.
6. **Report.** Write the file (below). Every row carries a verbatim Source and a Check. Close
   the Map with a `Guidelines read:` line listing every guideline and example file opened.

The mapping is complete when every file the task needs is mapped, every mapped section has
been read, every requirement has had both passes, and every row has its Source and Check.

## Released version vs master

A new custom addon on top of Odoo 20.0 follows the guidelines. A change inside an Odoo checkout
of a released version (`version_info` in `odoo/release.py` ends in `FINAL`) also follows
`../odoo-stable-policy/SKILL.md`: keep the diff minimal, match the surrounding code, no data
model change. Read that skill and add its rules as rows when the task changes Odoo itself.

## Version traps

Odoo's ORM and view syntax change between major versions (`attrs=`, `<tree>`, `name_get`,
`read_group` are gone from recent versions). Before a Check, row or assumption names an API or
attribute, confirm it exists in the checkout (`git grep` the ORM source or a usage at that
revision), not from memory.

## Where

`~/src/odoo/log/<task>_requirements.md`, with `<task>` a short lowercase slug with
underscores (`library_loans`). The name must end in `_requirements.md`: the review gate looks
for it. One file per task; a follow-up prompt updates the same file. It lives outside the
addon repository and is never committed.

## Format

```
# <task>: requirements

Task: <one sentence>
Base: <branch>, <commit the work starts from>

## Acceptance
<every threshold, count, score, version, name and definition-of-done line the prompt states,
copied exactly>

## Map
| Planned file or area | Guideline sections |
|---|---|
| models/library_loan.py | python.md#imports, python.md#naming-and-model-layout, orm.md#computes-onchange-and-constraints; examples_python.md, examples_orm.md |

Guidelines read: <the guideline and example files opened for this map, for example python.md, examples_python.md>

## Requirements
| # | Requirement | MUST/SHOULD | Source | Check | Verdict | Evidence |
|---|---|---|---|---|---|---|
| 1 | A confirmed `library.loan` cannot be edited by a portal user | MUST | "portal users never edit a confirmed loan" | test: portal user write raises AccessError | | |
| 2 | Loan list shows the due date | MUST | implied: "loans must be trackable" | screenshot of the list view | | |

## Out of scope
- <what the prompt says not to do>

## Assumptions
- <each ambiguity and the interpretation chosen>

## Changes
- <date> follow-up: <what changed, which rows>

## Review
<written by the final review, never at the start: see "The review" below>
```

Keep the requirements table columns as shown and `## Review` as the last section; the review
gate reads them. Leave Verdict and Evidence empty when you write the rows. Keep the Map table
free of the words "requirement" and "must" in its header.

## Writing the requirements

- One behaviour per row, stated so that a reviewer can answer yes or no: "the list shows 3
  rows with Total = 120.00", not "the list works". Split a row that has an "and".
- **MUST** is what the prompt states or what a stated requirement cannot work without;
  **SHOULD** is a nice-to-have the prompt hints at, which includes most merits-pass rows.
  Never drop or downgrade a requirement because it is hard.
- **Source** is a short verbatim quote from the prompt, or `implied: <the requirement or
  guideline section it follows from>`. This is how a reviewer tells what was asked from what
  was invented; a row with neither is deleted.
- **Check** says how the row will be verified: a test name, a log line, a screenshot. A row
  with no possible check is too vague; rewrite it.
- Copy numbers, names, paths, versions and hashes exactly. Never round, rename or
  paraphrase them. Where the prompt gives the value to match (a measured value, a score), the
  row names how it is measured.
- Do not soften: "must" stays MUST, and a failure condition does not become a goal.
- Do not ask. Choose the interpretation closest to the stated requirement and to Odoo
  conventions, and record it under Assumptions.

## The review

The review gate asks for it when you try to finish. It is recorded in this file, nowhere else:

- **Verdict / Evidence** on every row: `met` or `not met`, and what you ran or read for the
  review (command and result line, test name, log line, PNG path). Overwrite earlier values.
- **`## Review` section** (replace the placeholder): `Files reviewed:` with every file changed
  since `Base:`, the findings table (columns `# | File:line | Defect | Failure scenario | Fix |
  Guideline section or *judgement* | Status`, or `No findings.`), and a closing
  `Guidelines read: <files>` line. The gate's message states the exact steps and the bar.

## Keeping it current

- A follow-up prompt changes the file before any code does: run Scope, Map, Read and both
  passes again for what the prompt changes, edit the affected rows, add new ones, clear the
  Verdict and Evidence of every row you changed or added, and write a line under Changes. If
  nothing changed, write that line anyway.
- A correction in the prompt replaces the wrong row. Mark the old one `superseded by #<n>`
  and keep it, so the history stays readable.
- When the work enters an area that is not in the Map, add it, read its sections and run both
  passes for it before writing code there.
- After a context reset or compaction, re-read this file and the mapped sections of the next
  step before continuing; the summary does not hold the rules.
