# Examples: Web: SCSS

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-web-guidelines/guidelines/scss.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## SCSS and CSS

Guideline: [SCSS and CSS](../../odoo-web-guidelines/guidelines/scss.md#scss-and-css). Rule: Prefix classes with `o_<module>`, no `id` selectors, flat class names, 4-space indent.

**Good** `addons/crm/static/src/scss/crm_team.scss:1-11`: `o_crm_...` prefixed, flat class names, 4-space indent.

```scss
.o_crm_team_form_view {
    /*
    * Used to conditionnaly add a css class on a record field.
    * Add text-warning on the element with class o_crm_lead_month_assignment
    * only if the element with o_crm_lead_all_assigned_month_exceeded is visible
    * in the template.
    */
    div.o_crm_lead_all_assigned_month_exceeded + .o_crm_lead_month_assignment {
        color: $warning;
    }
}
```

**Violation** `addons/crm/static/src/scss/crm.scss:1-14`: `crm_lead_merge_summary`, `crm_quick_create_opportunity_form_group`, `crm_revenues`: classes without the `o_crm` prefix.

```scss
.crm_lead_merge_summary blockquote {
    font-style: normal;
}

.crm_quick_create_opportunity_form_group {
    padding-bottom: 0.5rem;

    i.oi {
        text-align: center;
        min-width: 2rem;
    }
    .crm_revenues .o_row {
        margin-left: 1.75rem;
    }
```
