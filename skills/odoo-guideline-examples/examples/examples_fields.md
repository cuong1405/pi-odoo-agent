# Examples: Fields

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/fields.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Fields

Guideline: [Fields](../../odoo-guidelines/guidelines/fields.md#fields). Rule: `_id` / `_ids` suffixes, selective indexes (`btree_not_null` for fields empty on most rows, `trigram` for `like`), `groups` on sensitive fields.

**Good** `addons/crm/models/crm_lead.py:183-188`: `index='btree_not_null'` on a field searched for exact values and empty on most rows.

```python
    email_domain_criterion = fields.Char(
        string='Email Domain Criterion',
        compute="_compute_email_domain_criterion",
        index='btree_not_null',  # used for exact match, void value do not matter
        store=True,
    )
```

**Good** `addons/crm/models/crm_lead.py:104-106`: `index='trigram'` on a field searched with `like`.

```python
    name = fields.Char(
        'Opportunity', index='trigram', required=True,
        compute='_compute_name', readonly=False, store=True)
```

**Violation** `addons/crm/models/crm_lead.py:146`: Many2one `recurring_plan` without the `_id` suffix. Fix: `recurring_plan_id`.

```python
    recurring_plan = fields.Many2one('crm.recurring.plan', string="Recurring Plan", index='btree_not_null')
```

**Violation** `addons/crm/models/crm_lead.py:153`: Many2one `company_currency` without the `_id` suffix. Fix: `company_currency_id`.

```python
    company_currency = fields.Many2one("res.currency", string='Currency', compute="_compute_company_currency", compute_sql="_compute_sql_company_currency", compute_sudo=True)
```
