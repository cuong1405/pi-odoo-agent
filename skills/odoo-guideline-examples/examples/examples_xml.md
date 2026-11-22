# Examples: XML views, actions and data

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/xml.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Views, actions and data records

Guideline: [Views, actions and data records](../../odoo-guidelines/guidelines/xml.md#views-actions-and-data-records). Rule: `id` before `model` on a record; `<odoo noupdate="1">` instead of `<data noupdate="1">` when the whole file is noupdate; xml id patterns `<model>_view_<type>`; prefer `<menuitem>`.

**Good** `addons/crm/views/crm_lead_views.xml:3-5`: `<record id=... model=...>`: `id` first.

```xml
        <record id="crm_lead_view_form" model="ir.ui.view">
            <field name="name">crm.lead.form</field>
            <field name="model">crm.lead</field>
```

**Violation** `addons/crm/views/crm_lead_views.xml:1018-1022`: `<record model=... id=...>`: `id` must come before `model`.

```xml
        <record model="ir.actions.act_window" id="crm_lead_all_leads">
            <field name="name">Leads</field>
            <field name="explanation">Opens the pipeline view for CRM Leads and Opportunities. Use this when the user wants to see sales prospects, track deal stages, or analyze their sales pipeline.</field>
            <field name="res_model">crm.lead</field>
            <field name="view_mode">list,kanban,graph,pivot,form,activity</field>
```

**Good** `addons/crm/data/crm_stage_data.xml:1-2`: Whole file is noupdate: `noupdate="1"` on `<odoo>`.

```xml
<?xml version="1.0" encoding="utf-8"?>
<odoo noupdate="1">
```

**Violation** `addons/crm/data/crm_team_data.xml:1-2`: `<odoo><data noupdate="1">` for a file that is entirely noupdate: set it on `<odoo>` and drop `<data>`.

```xml
<?xml version="1.0" encoding="utf-8"?>
<odoo><data noupdate="1">
```

**Good** `addons/crm/views/crm_menu_views.xml:9-14`: `<menuitem>` sugar tag instead of a raw `ir.ui.menu` record.

```xml
    <menuitem
        id="crm_menu_root"
        name="CRM"
        web_icon="crm,static/description/icon.png"
        groups="sales_team.group_sale_salesman,sales_team.group_sale_manager"
        sequence="25"/>
```

**Good** `addons/crm/views/crm_lead_views.xml:3`: View id `<model>_view_<type>` pattern: `crm_lead_view_form`.

```xml
        <record id="crm_lead_view_form" model="ir.ui.view">
```

**Good** `addons/crm/views/crm_team_views.xml:123-127`: An inheriting view reuses the id of the original record (`crm_team_view_tree`) and its `name` carries the `.inherit.<details>` suffix.

```xml
        <record id="crm_team_view_tree" model="ir.ui.view">
            <field name="name">crm.team.list.inherit.crm</field>
            <field name="model">crm.team</field>
            <field name="inherit_id" ref="sales_team.crm_team_view_tree"/>
            <field name="arch" type="xml">
```


## Anchor view inheritance on names, never on position

Guideline: [Anchor view inheritance on names, never on position](../../odoo-guidelines/guidelines/xml.md#anchor-view-inheritance-on-names-never-on-position). Rule: Anchor on a stable `name`; never on document position.

**Good** `addons/crm/views/crm_team_views.xml:128-130`: Shorthand form: matches the field by name.

```xml
                <field name="name" position="after">
                    <field string="Alias" name="alias_full_name"/>
                </field>
```

**Good** `addons/crm/views/crm_team_views.xml:180-183`: xpath anchored on `@name`.

```xml
                <xpath expr="//group[@name='right']" position="attributes">
                    <attribute name="string">Assignment Rules</attribute>
                    <attribute name="invisible">not assignment_enabled</attribute>
                </xpath>
```

**Violation** `addons/crm/views/crm_team_views.xml:140`: `//form/*[1]` anchors on position: breaks when the parent view reorders. Fix: anchor on a named element of the parent.

```xml
                <xpath expr="//form/*[1]" position="before">
```
