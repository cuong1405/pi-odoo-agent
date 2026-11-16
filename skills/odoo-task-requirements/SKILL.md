---
name: odoo-task-requirements
description: >-
  Turn an Odoo task prompt into a task requirements file that the final review is
  measured against. Use at the start of a task, before writing code, when the prompt
  asks for it or the task is large; and again whenever a follow-up prompt adds,
  changes or corrects a requirement.
---

# Task requirements

Write down what the task asks, before touching code, in one file. The final review
(`odoo-review`, run by the review gate) is measured against it, so a requirement that is not
in the file is not reviewed. The file is a faithful record of the prompt, not a plan and not
a summary.

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

## Requirements
| # | Requirement | MUST/SHOULD | Source | Check |
|---|---|---|---|---|
| 1 | A confirmed `library.loan` cannot be edited by a portal user | MUST | "portal users never edit a confirmed loan" | test: portal user write raises AccessError |
| 2 | Loan list shows the due date | MUST | implied: "loans must be trackable" | screenshot of the list view |

## Out of scope
- <what the prompt says not to do>

## Assumptions
- <each ambiguity and the interpretation chosen>

## Changes
- <date> follow-up: <what changed, which rows>
```

The sections above are the content to cover; keep the table columns as shown.

## Writing the requirements

- One behaviour per row, stated so that a reviewer can answer yes or no: "the list shows 3
  rows with Total = 120.00", not "the list works". Split a row that has an "and".
- **MUST** is what the prompt states or what a stated requirement cannot work without;
  **SHOULD** is a nice-to-have the prompt hints at. Never drop or downgrade a requirement
  because it is hard.
- **Source** is a short verbatim quote from the prompt, or `implied: <the requirement it
  follows from>`. This is how a reviewer tells what was asked from what was invented; a row
  with neither is deleted.
- **Check** says how the row will be verified: a test name, a log line, a screenshot. A row
  with no possible check is too vague; rewrite it.
- Copy numbers, names, paths, versions and hashes exactly. Never round, rename or
  paraphrase them. Where the prompt gives the value to match (a measured value, a score), the
  row names how it is measured.
- Do not soften: "must" stays MUST, and a failure condition does not become a goal.
- Do not ask. Choose the interpretation closest to the stated requirement and to Odoo
  conventions, and record it under Assumptions.

## Implied requirements in Odoo

After the stated requirements, read the index in `odoo-guidelines/SKILL.md` (and
`odoo-web-guidelines` when the task touches `static/`) and add a row for every area the task
touches whose requirement the prompt does not state. Typical ones: access rights (ACL rows
and record rules for every new model, who must not be able to read or write), views, actions
and menus for new models, translatable user-facing strings, demo data (shipped in the
manifest `demo` key; tests must not depend on it being present), an upgrade (`-u`) on a
populated database, multi-company behaviour, and tests named for the behaviour they check.
Add only what the task touches; an unrelated area is not a requirement.

## Keeping it current

- A follow-up prompt changes the file before any code does: edit the affected rows, add new
  ones, and write a line under Changes. If nothing changed, write that line anyway.
- A correction in the prompt replaces the wrong row. Mark the old one `superseded by #<n>`
  and keep it, so the history stays readable.
- When you discover an implied requirement mid-task, add a row for it.
- After a context reset, re-read the file before continuing.
