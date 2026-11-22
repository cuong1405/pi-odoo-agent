# Examples: Tests

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/tests.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Tests

Guideline: [Tests](../../odoo-guidelines/guidelines/tests.md#tests). Rule: Tag exactly one of `at_install` / `post_install`; start from `BaseCommon`; build shared records in `setUpClass`; `assertQueryCount` only in dedicated performance tests; `mute_logger` for expected errors; every test file imported from `tests/__init__.py`.

**Good** `addons/crm/tests/test_crm_ui.py:8-9`: `@tagged('post_install', '-at_install')` on an `HttpCase`.

```python
@tagged('post_install', '-at_install')
class TestUi(HttpCase, TestCrmCommon):
```

**Violation** `addons/crm/tests/test_digest.py:12-13`: `at_install` with only a `# LEGACY at_install` comment: the guideline asks for a comment that justifies why the test must run before other modules load.

```python
@tagged('at_install', '-post_install')  # LEGACY at_install
class TestCrmDigest(TestDigestCommon):
```

**Good** `addons/sales_team/tests/common.py:1-20`: A common test class built on `BaseCommon`, with shared records built once in `setUpClass`.

```python
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo.tests import TransactionCase

from odoo.addons.base.tests.common import BaseCommon
from odoo.addons.mail.tests.common import mail_new_test_user


class SalesTeamCommon(BaseCommon):
    _test_user_groups = ('sales_team.group_sale_salesman',)

    _test_user_name = 'Test Sales User'

    @classmethod
    def setUpClass(cls):
        super().setUpClass()

        cls.group_sale_salesman = cls.env.ref('sales_team.group_sale_salesman')
        cls.group_sale_manager = cls.env.ref('sales_team.group_sale_manager')

```

**Good** `addons/crm/tests/test_performances.py:57-61`: `assertQueryCount` in a dedicated performance test, after a warmup.

```python
        # randomness: at least 1 query, +3 for demo -> 868 + 5
        with self.with_user('user_sales_manager'):
            self.env.user._is_internal()  # warmup the cache to avoid inconsistency between community an enterprise
            with self.assertQueryCount(user_sales_manager=753):
                self.env['crm.team'].browse(self.sales_teams.ids)._action_assign_leads()
```

**Good** `addons/crm/tests/__init__.py:1-8`: Every test module is imported from `tests/__init__.py`; a file not imported here never runs.

```python
# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from . import test_crm_activity
from . import test_crm_lead
from . import test_crm_lead_assignment
from . import test_crm_lead_duration_mixin
from . import test_crm_lead_notification
```
