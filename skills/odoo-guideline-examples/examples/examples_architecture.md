# Examples: Architecture

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/architecture.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Put code in the module that owns its concern

Guideline: [Put code in the module that owns its concern](../../odoo-guidelines/guidelines/architecture.md#put-code-in-the-module-that-owns-its-concern). Rule: A feature that connects two apps goes in a bridge module that depends on both and is auto_install.

**Good** `addons/sale_crm/__manifest__.py:17-27`: `sale_crm` connects the sale and crm apps: depends on both, `auto_install` so it is installed exactly when both are.

```python
    'depends': ['sale', 'crm'],
    'data': [
        'data/crm_lead_merge_template.xml',
        'views/sale_order_views.xml',
        'views/crm_lead_views.xml',
        'views/crm_team_views.xml',
        'wizard/crm_opportunity_to_quotation_views.xml',
        'security/ir.access.csv',
    ],
    'auto_install': True,
    'uninstall_hook': 'uninstall_hook',
```
