# Examples: Manifest

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/manifest.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Manifest

Guideline: [Manifest](../../odoo-guidelines/guidelines/manifest.md#manifest). Rule: Direct dependencies only (never `base`), correct license, `application` only for full apps, assets declared in the manifest.

**Good** `addons/crm/__manifest__.py:1-23`: `depends` lists direct dependencies and not `base`.

```python
# Part of Odoo. See LICENSE file for full copyright and licensing details.


{
    'name': 'CRM',
    'version': '1.9',
    'category': 'Sales/CRM',
    'sequence': 15,
    'summary': 'Track leads and close opportunities',
    'website': 'https://www.odoo.com/app/crm',
    'depends': [
        'base_setup',
        'base_install_request',
        'sales_team',
        'mail',
        'calendar',
        'resource',
        'utm',
        'web_tour',
        'contacts',
        'digest',
        'phone_validation',
    ],
```

**Good** `addons/crm/__manifest__.py:64-71`: `demo` files are separate from `data`; `application` is True because crm is a full app.

```python
    'demo': [
        'data/crm_team_demo.xml',
        'data/crm_stage_demo.xml',
        'data/mail_template_demo.xml',
        'data/crm_team_member_demo.xml',
        'data/crm_lead_demo.xml',
    ],
    'application': True,
```

**Good** `addons/crm/__manifest__.py:97-108`: Test assets declared in the manifest `assets` key, and the license set deliberately.

```python
        'web.assets_tests': [
            'crm/static/tests/tours/**/*',
        ],
        'web.assets_unit_tests': [
            'crm/static/tests/mock_server/**/*',
            'crm/static/tests/crm_test_helpers.js',
            'crm/static/tests/**/*.test.js',
            'crm/static/tests/crm_mock_server.js'
        ],
    },
    'author': 'Odoo S.A.',
    'license': 'LGPL-3',
```
