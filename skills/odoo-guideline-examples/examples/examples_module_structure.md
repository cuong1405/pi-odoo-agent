# Examples: Module structure

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/module_structure.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Module structure and file naming

Guideline: [Module structure and file naming](../../odoo-guidelines/guidelines/module_structure.md#module-structure-and-file-naming). Rule: Standard directories, one model class per file named after the model, suffix conventions.

**Layout** `addons/crm/wizard/`: Wizard: `<transient>.py` + `<transient>_views.xml`.

```
__init__.py
crm_lead_lost.py
crm_lead_lost_views.xml
crm_lead_pls_update.py
crm_lead_pls_update_views.xml
crm_lead_to_opportunity_mass.py
crm_lead_to_opportunity_mass_views.xml
crm_merge_opportunities.py
crm_merge_opportunities_views.xml
```

**Layout** `addons/crm/report/`: Statistics (SQL view) report: `<model>_report.py` + `<model>_report_views.xml` (here `crm_activity_report`).

```
__init__.py
crm_activity_report.py
crm_activity_report_views.xml
crm_opportunity_report_views.xml
```

**Layout** `addons/crm/security/`: Access rows in `ir.access.csv`, groups in `<module>_security.xml`.

```
crm_security.xml
ir.access.csv
```

**Violation** `addons/crm/models/crm_lead_scoring_frequency.py:7-20`: Two model classes in one file: each model gets its own file named after it.

```python
class CrmLeadScoringFrequency(models.Model):
    _name = 'crm.lead.scoring.frequency'
    _description = 'Lead Scoring Frequency'

    variable = fields.Char('Variable', index=True)
    value = fields.Char('Value')
    won_count = fields.Float('Won Count', digits=(16, 1))  # Float because we add 0.1 to avoid zero Frequency issue
    lost_count = fields.Float('Lost Count', digits=(16, 1))  # Float because we add 0.1 to avoid zero Frequency issue
    team_id = fields.Many2one('crm.team', 'Sales Team', ondelete="cascade")


class CrmLeadScoringFrequencyField(models.Model):
    _name = 'crm.lead.scoring.frequency.field'
    _description = 'Fields that can be used for predictive lead scoring computation'
```

**Layout** `addons/crm/controllers/`: `main.py` is the legacy controller name; prefer a feature name, or `<inherited_module>.py` when extending.

```
__init__.py
main.py
webmanifest.py
```
