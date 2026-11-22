# Examples: Controllers

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/controllers.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Controllers

Guideline: [Controllers](../../odoo-guidelines/guidelines/controllers.md#controllers). Rule: `@route` on every route with the right `auth`; re-decorate an override with `@route`.

**Good** `addons/crm/controllers/main.py:11-14`: `@http.route` with an explicit `type`, `auth` and `methods`.

```python
class CrmController(http.Controller):

    @http.route('/lead/case_mark_won', type='http', auth='user', methods=['GET'])
    def crm_lead_case_mark_won(self, res_id, token):
```
