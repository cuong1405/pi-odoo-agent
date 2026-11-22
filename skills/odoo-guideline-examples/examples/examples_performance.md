# Examples: Performance

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/performance.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Batch ORM calls

Guideline: [Batch ORM calls](../../odoo-guidelines/guidelines/performance.md#batch-orm-calls). Rule: One ORM call for the whole collection; no `search`, `search_count`, `_read_group` or `create` inside a loop over records.

**Good** `addons/crm/models/crm_team.py:77-84`: One grouped `_read_group`, then a dict lookup per record.

```python
    def _compute_lead_unassigned_count(self):
        leads_data = self.env['crm.lead']._read_group([
            ('team_id', 'in', self.ids),
            ('user_id', '=', False),
        ], ['team_id'], ['__count'])
        counts = {team.id: count for team, count in leads_data}
        for team in self:
            team.lead_unassigned_count = counts.get(team.id, 0)
```

**Violation** `addons/crm/wizard/crm_merge_opportunities.py:46-56`: `search_count` and `search` inside `for wizard in self`: one query per record.

```python
    @api.depends('user_id')
    def _compute_team_id(self):
        """ When changing the user, also set a team_id or restrict team id
            to the ones user_id is member of. """
        for wizard in self:
            if wizard.user_id:
                user_in_team = False
                if wizard.team_id:
                    user_in_team = wizard.env['crm.team'].search_count([('id', '=', wizard.team_id.id), '|', ('user_id', '=', wizard.user_id.id), ('member_ids', '=', wizard.user_id.id)])
                if not user_in_team:
                    wizard.team_id = wizard.env['crm.team'].search(['|', ('user_id', '=', wizard.user_id.id), ('member_ids', '=', wizard.user_id.id)], limit=1)                    
```

**Violation** `addons/crm/models/crm_team.py:140-164`: `create` inside the loop over `frequencies`: collect the values and create once after the loop.

```python
            for frequency in frequencies:
                # skip void-like values
                if float_compare(frequency.won_count, 0.1, 2) != 1 and float_compare(frequency.lost_count, 0.1, 2) != 1:
                    continue

                match = existing_noteam.filtered(lambda frequ_nt: frequ_nt.variable == frequency.variable and frequ_nt.value == frequency.value)
                if match:
                    # remove extra .1 that may exist in db as those are artifacts of initializing
                    # frequency table. Final value of 0 will be set to 0.1.
                    exist_won_count = float_round(match.won_count, precision_digits=0, rounding_method='HALF-UP')
                    exist_lost_count = float_round(match.lost_count, precision_digits=0, rounding_method='HALF-UP')
                    add_won_count = float_round(frequency.won_count, precision_digits=0, rounding_method='HALF-UP')
                    add_lost_count = float_round(frequency.lost_count, precision_digits=0, rounding_method='HALF-UP')
                    new_won_count = exist_won_count + add_won_count
                    new_lost_count = exist_lost_count + add_lost_count
                    match.won_count = new_won_count if float_compare(new_won_count, 0.1, 2) == 1 else 0.1
                    match.lost_count = new_lost_count if float_compare(new_lost_count, 0.1, 2) == 1 else 0.1
                else:
                    existing_noteam += self.env['crm.lead.scoring.frequency'].sudo().create({
                        'lost_count': frequency.lost_count if float_compare(frequency.lost_count, 0.1, 2) == 1 else 0.1,
                        'team_id': False,
                        'value': frequency.value,
                        'variable': frequency.variable,
                        'won_count': frequency.won_count if float_compare(frequency.won_count, 0.1, 2) == 1 else 0.1,
                    })
```


## Use search_fetch when the domain and the rules are simple

Guideline: [Use search_fetch when the domain and the rules are simple](../../odoo-guidelines/guidelines/performance.md#use-search_fetch-when-the-domain-and-the-rules-are-simple). Rule: `search_fetch(domain, fields)` saves a query when the fields read are known.

**Good** `addons/account/models/account_analytic_account.py:52-59`: `search_fetch(..., ['move_id'])` then reads `move_id`.

```python
        account_move_lines = self.env['account.move.line'].search_fetch([
            ('move_id.move_type', 'in', self.env['account.move'].get_sale_types()),
            ('analytic_distribution', 'in', self.ids),
        ], ['move_id'])
        return {
            "type": "ir.actions.act_window",
            "res_model": "account.move",
            "domain": [('id', 'in', account_move_lines.move_id.ids)],
```


## Do not read an x2many that grows without bound

Guideline: [Do not read an x2many that grows without bound](../../odoo-guidelines/guidelines/performance.md#do-not-read-an-x2many-that-grows-without-bound). Rule: Do not read messages, followers, members or logs to count or test them; ask the comodel with `search_count(..., limit=...)`.

**Violation** `addons/crm/models/crm_lead.py:1117-1119`: `len(self.message_ids) >= 25` loads every message id of the lead. Fix: ask `mail.message` with `search_count(..., limit=25)` using the domain of the `message_ids` field, as the guideline example does for `loan_ids`.

```python
        # checked here as it is its position in the priority order
        if len(self.message_ids) >= 25:
            return _('Phew, that took some effort — but you nailed it. Good job!')
```
