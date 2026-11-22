# Examples: ORM

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/orm.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Recordsets, domains and context

Guideline: [Recordsets, domains and context](../../odoo-guidelines/guidelines/orm.md#recordsets-domains-and-context). Rule: Combine domains with `odoo.fields.Domain`; never hand-build `'&'`/`'|'` prefix lists.

**Good** `addons/crm/models/crm_team.py:458-465`: `Domain.AND([...])` and `&=` with `Domain(...)`.

```python
            lead_domain = Domain.AND([
                literal_eval(team.assignment_domain or '[]'),
                [('create_date', '<=', max_create_dt)],
                ['&', ('team_id', '=', False), ('user_id', '=', False)],
                [('won_status', '!=', 'won')]
            ])
            if creation_delta_days > 0:
                lead_domain &= Domain('create_date', '>', self.env.cr.now() - datetime.timedelta(days=creation_delta_days))
```

**Good** `addons/crm/models/crm_stage.py:39-42`: Inline domains combined with the `|` operator.

```python
    @api.model
    def _get_visible_stages_domain(self, team_ids):
        """ Returns the "crm.stage" domain to know which stages are visible for the given team ids. """
        return Domain("team_ids", "in", team_ids) | Domain("team_ids", "=", False)
```

**Violation** `addons/crm/models/crm_team.py:205-208`: Hand-built prefix notation `'&', '|', ...`. Fix: combine `Domain` objects with `&` and `|`.

```python
        self.env['crm.team'].search([
            '&', '|', ('use_leads', '=', True), ('use_opportunities', '=', True),
            ('assignment_optout', '=', False)
        ])._action_assign_leads(force_quota=force_quota, creation_delta_days=creation_delta_days)
```

**Violation** `addons/crm/models/crm_lead.py:1017-1020`: Hand-built `['|', ...]` list for a domain that is then extended.

```python
        if team_ids:
            search_domain = ['|', ('team_ids', '=', False), ('team_ids', 'in', list(team_ids))]
        else:
            search_domain = [('team_ids', '=', False)]
```


## Computes, onchange and constraints

Guideline: [Computes, onchange and constraints](../../odoo-guidelines/guidelines/orm.md#computes-onchange-and-constraints). Rule: `@api.model_create_multi` for `create`; SQL constraints and indexes as model attributes (`models.Constraint`, `models.Index`), never `_sql_constraints`.

**Good** `addons/crm/models/crm_lead.py:728-733`: `create` takes `vals_list` and is decorated with `@api.model_create_multi`.

```python
    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('website'):
                vals['website'] = self.env['res.partner']._clean_website(vals['website'])
        leads = super().create(vals_list)
```

**Good** `addons/crm/models/crm_lead.py:249-255`: `models.Constraint` and `models.Index` attributes.

```python
    _check_probability = models.Constraint(
        'check(probability >= 0 and probability <= 100)',
        'The probability of closing the deal should be between 0% and 100%!',
    )
    _user_id_team_id_type_index = models.Index("(user_id, team_id, type)")
    _create_date_team_id_idx = models.Index("(create_date, team_id)")
    _default_order_idx = models.Index('(priority DESC, id DESC) WHERE active IS TRUE')
```


## End `_order` on a unique field

Guideline: [End `_order` on a unique field](../../odoo-guidelines/guidelines/orm.md#end-_order-on-a-unique-field). Rule: A model's `_order` ends with a unique field, usually `id`.

**Good** `addons/crm/models/crm_stage.py:25`: `_order = "sequence, name, id"`.

```python
    _order = "sequence, name, id"
```

**Good** `addons/crm/models/crm_lead.py:88`: `_order = "priority desc, id desc"`: `id desc` after a `desc` term.

```python
    _order = "priority desc, id desc"
```

**Violation** `addons/crm/models/crm_recurring_plan.py:8-16`: `_order = "sequence"`: two plans with the same sequence come back in any order. Fix: `"sequence, id"`.

```python
    _name = 'crm.recurring.plan'
    _description = "CRM Recurring Revenue Plan"
    _explanation = "Defines billing intervals for recurring revenues (e.g., Monthly, Yearly). Applied to leads/opportunities to estimate future subscription income."
    _order = "sequence"

    name = fields.Char('Plan Name', required=True, translate=True)
    number_of_months = fields.Integer('# Months', required=True)
    active = fields.Boolean('Active', default=True)
    sequence = fields.Integer('Sequence', default=10)
```


## Set a state, never flip it

Guideline: [Set a state, never flip it](../../odoo-guidelines/guidelines/orm.md#set-a-state-never-flip-it). Rule: A method sets a fixed state; a state that goes both ways gets one method per direction.

**Good** `addons/crm/models/crm_lead.py:1051-1059`: `action_set_lost` and `action_set_won` set a fixed state (archive / unarchive plus the probability), never a flip.

```python
    def action_set_lost(self, **additional_values):
        """ Lost semantic: probability = 0 AND active = False """
        res = self.action_archive()
        self.write({**additional_values, 'probability': 0, 'automated_probability': 0})
        return res

    def action_set_won(self):
        """ Won semantic: stage.is_won (AND probability = 100 but implied) """
        self.action_unarchive()
```

**Good** `addons/hr_recruitment/models/hr_applicant.py:1117-1123`: `action_archive` / `action_unarchive`: one method per direction.

```python
    def action_archive(self):
        return super(HrApplicant, self.with_context(just_unarchived=True)).action_archive()

    def action_unarchive(self):
        res = super(HrApplicant, self.with_context(just_unarchived=True)).action_unarchive()
        self.reset_applicant()
        return res
```

**Violation** `addons/delivery/models/delivery_carrier.py:231-237`: `toggle_prod_environment` and `toggle_debug` read the current value to write its opposite. Fix: one method per direction, or a method taking the state to reach.

```python
    def toggle_prod_environment(self):
        for c in self:
            c.prod_environment = not c.prod_environment

    def toggle_debug(self):
        for c in self:
            c.debug_logging = not c.debug_logging
```


## Methods and extension points

Guideline: [Methods and extension points](../../odoo-guidelines/guidelines/orm.md#methods-and-extension-points). Rule: Logic another module overrides goes in its own small private method; public names are RPC entry points.

**Good** `addons/crm/models/crm_lead.py:382-386`: `_get_rotting_domain` is a small private hook that the model extends with `super()` and a `Domain`.

```python
    def _get_rotting_domain(self):
        return super()._get_rotting_domain() & Domain([
            ('won_status', '=', 'pending'),
            ('type', '=', 'opportunity'),
        ])
```


## Transactions and exceptions

Guideline: [Transactions and exceptions](../../odoo-guidelines/guidelines/orm.md#transactions-and-exceptions). Rule: Never `cr.commit()` unless you own the cursor, and justify an unavoidable one; catch specific exceptions over the smallest block.

**Violation** `addons/crm/models/crm_team.py:106-114`: `except Exception` around a domain search: catch the specific exceptions the call raises, over the smallest block.

```python
    @api.constrains('assignment_domain')
    def _constrains_assignment_domain(self):
        for team in self:
            try:
                domain = literal_eval(team.assignment_domain or '[]')
                if domain:
                    self.env['crm.lead'].search(domain, limit=1)
            except Exception:
                raise exceptions.ValidationError(_('Assignment domain for team %(team)s is incorrectly formatted', team=team.name))
```

**Observed** `addons/crm/models/crm_lead.py:2459-2466`: A batched job that commits the framework's cursor with a short comment and swallows `Exception`. A commit on the framework cursor needs a comment that justifies why it is unavoidable, and an `except Exception` should name what it expects.

```python
                try:
                    self.env.cr.execute(update_sql, (probability, probability, tuple(lead_ids_current)))
                    # auto-commit except in testing mode
                    if auto_commit:
                        self.env.cr.commit()
                except Exception as e:
                    _logger.warning("Predictive Lead Scoring : update transaction failed. Error: %s" % e)
                    transactions_failed_count += 1
```

**Observed** `addons/crm/models/crm_team.py:554-556`: A `cr.commit()` helper with no comment saying why it is unavoidable. Do not add one like it; if a commit is unavoidable, say why next to it.

```python
    def _auto_commit_if_not_test(self):
        if not modules.module.current_test:
            self.env.cr.commit()
```
