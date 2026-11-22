# Examples: QWeb reports

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/reports.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## QWeb PDF reports

Guideline: [QWeb PDF reports](../../odoo-guidelines/guidelines/reports.md#qweb-pdf-reports). Rule: A custom `_get_report_values` adds `docs` / `doc_ids` / `doc_model` itself.

**Good** `addons/account/report/account_invoice_report.py:162-178`: `_get_report_values` returns `doc_ids`, `doc_model` and `docs` itself.

```python
    @api.model
    def _get_report_values(self, docids, data=None):
        docs = self.env['account.move'].browse(docids)

        qr_code_urls = {}
        for invoice in docs:
            if invoice.display_qr_code:
                new_code_url = invoice._generate_qr_code(silent_errors=data['report_type'] == 'html')
                if new_code_url:
                    qr_code_urls[invoice.id] = new_code_url

        return {
            'doc_ids': docids,
            'doc_model': 'account.move',
            'docs': docs,
            'qr_code_urls': qr_code_urls,
        }
```
