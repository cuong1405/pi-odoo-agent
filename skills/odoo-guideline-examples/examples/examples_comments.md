# Examples: Comments and messages

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/comments.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Plain ASCII punctuation in comments and messages

Guideline: [Plain ASCII punctuation in comments and messages](../../odoo-guidelines/guidelines/comments.md#plain-ascii-punctuation-in-comments-and-messages). Rule: ASCII punctuation only in comments, docstrings, user-facing strings and commit messages: no em dash, en dash, curly quotes or the ellipsis character.

**Violation** `addons/crm/models/crm_lead.py:1119`: Em dash in a translatable string. Fix: `'Phew, that took some effort, but you nailed it. Good job!'`.

```python
            return _('Phew, that took some effort — but you nailed it. Good job!')
```

**Violation** `addons/crm/models/crm_lead.py:1181`: Curly apostrophe in a translatable string. Fix: `didn't`.

```python
            return _('Wow, that was fast. That deal didn’t stand a chance!')
```
