# Examples: Python: imports, naming, translation

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/python.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Imports

Guideline: [Imports](../../odoo-guidelines/guidelines/python.md#imports). Rule: Four groups, each alphabetically sorted: stdlib, third-party, `odoo`, `odoo.addons.*`.

**Good** `addons/crm/models/crm_stage.py:1-5`: `odoo` group sorted.

```python
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import _, api, fields, models
from odoo.fields import Domain
from odoo.tools import sql
```

**Violation** `addons/crm/models/crm_lead.py:3-21`: `odoo.addons.*` imports sit between `odoo` imports, `odoo.tools.translate` comes before `odoo.tools`, and the import of `_` is the bare legacy form.

```python
import logging
import re
from ast import literal_eval
from collections import OrderedDict, defaultdict
from datetime import datetime, timedelta, UTC
from zoneinfo import ZoneInfo

from markupsafe import Markup

from odoo import api, fields, models, modules, tools
from odoo.addons.iap.tools import iap_tools
from odoo.addons.phone_validation.tools import phone_validation
from odoo.exceptions import UserError, AccessError, ValidationError
from odoo.fields import Domain
from odoo.tools.translate import _
from odoo.tools import clean_context, email_normalize_all, is_html_empty, groupby, parse_contact_from_email, SQL
from odoo.tools.misc import get_lang

from . import crm_stage
```

**Violation** `addons/crm/models/crm_team_member.py:4-9`: `from ast import literal_eval` is split from the other stdlib imports by a blank line, and `_` comes last in the `odoo` import where the ruff isort order puts it first.

```python
import datetime
import logging

from ast import literal_eval

from odoo import api, exceptions, fields, models, _
```


## Naming and model layout

Guideline: [Naming and model layout](../../odoo-guidelines/guidelines/python.md#naming-and-model-layout). Rule: Dotted singular `_name`; method-name patterns (`_compute_*`, `_default_*`, `action_*`); private attributes first, then fields, then constraints and indexes, then computes, CRUD overrides, actions.

**Good** `addons/crm/models/crm_lead.py:84-100`: Private attributes (`_name`, `_description`, `_order`, `_inherit`) open the model.

```python
class CrmLead(models.Model):
    _name = 'crm.lead'
    _description = "Lead"
    _explanation = "Represents a potential sales opportunity or lead. Use this to track interactions, estimated revenue, and the progress of a potential sale through different stages of your sales pipeline."
    _order = "priority desc, id desc"
    _inherit = [
                'mail.thread.subject.suggested',
                'mail.thread.blacklist',
                'mail.thread.phone',
                'mail.activity.mixin',
                'utm.mixin',
                'format.address.mixin',
                'mail.tracking.duration.mixin',
               ]
    _primary_email = 'email_from'
    _check_company_auto = True
    _track_duration_field = 'stage_id'
```

**Good** `addons/crm/models/crm_lead.py:249-255`: `models.Constraint` / `models.Index` attributes follow the fields; the attribute names start with `_`.

```python
    _check_probability = models.Constraint(
        'check(probability >= 0 and probability <= 100)',
        'The probability of closing the deal should be between 0% and 100%!',
    )
    _user_id_team_id_type_index = models.Index("(user_id, team_id, type)")
    _create_date_team_id_idx = models.Index("(create_date, team_id)")
    _default_order_idx = models.Index('(priority DESC, id DESC) WHERE active IS TRUE')
```

**Good** `addons/crm/models/crm_lead.py:388-392`: Compute method named `_compute_<field>` with `@api.depends` (the translated string in it is a violation, see below).

```python
    @api.depends('partner_id')
    def _compute_name(self):
        for lead in self:
            if not lead.name and lead.partner_id and lead.partner_id.name:
                lead.name = _("%s's opportunity") % lead.partner_id.name
```


## Translate only static literals

Guideline: [Translate only static literals](../../odoo-guidelines/guidelines/python.md#translate-only-static-literals). Rule: Pass values as arguments of the lookup, never format before or after it; use `self.env._` in model code.

**Good** `addons/crm/models/crm_lead.py:935`: Interpolation value passed as an argument of `_()`.

```python
                raise ValidationError(_("The lead %s cannot be won and lost at the same time.", lead))
```

**Good** `addons/account/models/account_reconcile_model.py:179-181`: `self.env._(...)` with a static literal, the current API.

```python
                raise ValidationError(self.env._("The payment tolerance must be positive."))
            if model.payment_tolerance_type == 'percentage' and not 0 <= model.payment_tolerance <= 100:
                raise ValidationError(self.env._("The percentage tolerance must be between 0 and 100."))
```

**Good** `addons/account_edi_ubl_cii/models/account_edi_common.py:1537`: `self.env._` with a value argument.

```python
                    logs.append(self.env._("The currency '%s' is not active.", currency.name))
```

**Violation** `addons/crm/models/crm_lead.py:392`: Formats with `%` after the lookup: bypasses placeholder validation. Fix: `self.env._("%s's opportunity", lead.partner_id.name)`.

```python
                lead.name = _("%s's opportunity") % lead.partner_id.name
```

**Violation** `addons/crm/models/crm_lead.py:17`: The bare `_` import is the backward-compatible API; prefer `self.env._`.

```python
from odoo.tools.translate import _
```
