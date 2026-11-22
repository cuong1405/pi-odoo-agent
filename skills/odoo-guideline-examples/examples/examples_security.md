# Examples: Access rights

Real Odoo 20.0 code (commit `530bc2789e2`) against `odoo-guidelines/guidelines/security.md`, which you read whole as well. **Good** follows the rule. **Violation** is upstream code that breaks it: recognise the pattern, never copy it, never extend it. **Observed** is neither clean nor a clear violation. How to read these examples: `../SKILL.md`.


## Access rights

Guideline: [Access rights](../../odoo-guidelines/guidelines/security.md#access-rights). Rule: `ir.access.csv` rows: permissions with a group are OR-ed, group-less rows are restrictions on everyone; multi-company models need a group-less company restriction; never grant c/u/d to everyone, portal or public.

**Good** `addons/crm/security/ir.access.csv:1-5`: Permission rows with a group and an `operation` subset (`crud`, `cru`), a row restricted by `domain`, and the group-less multi-company restriction `crm_lead_company_rule` with `company_ids + [False]`.

```csv
id,name,model_id,group_id/id,operation,domain
crm_rule_all_lead,All Leads,crm.lead,sales_team.group_sale_manager,crud,
crm_rule_personal_lead,Personal Leads,crm.lead,sales_team.group_sale_salesman,cru,"['|',('user_id','=',user.id),('user_id','=',False)]"
crm_rule_all_lead_1,All Leads,crm.lead,sales_team.group_sale_salesman_all_leads,cru,
crm_lead_company_rule,CRM Lead Multi-Company,crm.lead,,crud,"[('company_id', 'in', company_ids + [False])]"
```
