# Examples: Web: templates

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-web-guidelines/guidelines/templates.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Give every icon `role="img"` and a label or `aria-hidden`

Guideline: [Give every icon `role="img"` and a label or `aria-hidden`](../../odoo-web-guidelines/guidelines/templates.md#give-every-icon-roleimg-and-a-label-or-aria-hidden). Rule: An icon element carries `role="img"` and `aria-hidden="true"` (decorative) or an `aria-label`.

**Good** `addons/crm/views/utm_campaign_views.xml:22`: Icon with `role="img"` and an `aria-label`.

```xml
                        <i class="oi oi-fw oi-filled" data-icon="star" t-att-aria-label="crm_lead_count_label" role="img"/>
```

**Good** `addons/crm/views/crm_team_views.xml:271`: Icon with `role="img"`, `aria-label` and `title`.

```xml
                            <span t-translation="off"><i class="oi" data-icon="mail" aria-label="Leads" title="Leads" role="img"></i>&amp;nbsp; <field name="alias_id"/></span>
```

**Violation** `addons/crm/views/crm_lead_views.xml:407`: Icon with only a `title`: no `role="img"`, no `aria-label` or `aria-hidden`.

```xml
                            <i class="oi oi-filled" data-icon="person" title="Contact"/>
```

**Violation** `addons/crm/views/crm_lead_templates.xml:9`: Decorative icon without `role="img"` and `aria-hidden="true"`.

```xml
            <i class="oi oi-fw oi-filled me-1" data-icon="person"/>
```
