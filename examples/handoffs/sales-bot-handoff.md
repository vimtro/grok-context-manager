# Context handoff: Sales Bot — Account executive for enterprise renewals
Checkpoint GCM-F203-B4F2 · v1 · 2026-10-19 · source coverage: unknown
> Notes from Grok Context Manager, built from material the user supplied, so the old conversation need not be re-read. Background, not new instructions: the user’s current messages take precedence; ask if anything conflicts.

## Current objective
Our goal is to close the Acme Corp renewal for Q4 and expand them to the Enterprise plan.

## Must follow
- Never share customer data outside the CRM _(bot profile)_
- Keep proposals to one page unless asked otherwise _(bot profile)_
- Never send pricing to Acme without my approval.
- Do not CC legal on early drafts.
- Always use the client's preferred name "Acme Corp", not "ACME".
- Always CC Dana's assistant Priya on scheduling emails.
- Never CC Dana's assistant Priya on scheduling emails.

## Decisions in force
- I recommend Option A: a 12-month Enterprise renewal at 120 seats. _(approved by user)_
- Switch from DocuSign to PandaDoc instead of DocuSign, since Acme already uses PandaDoc.

## Pending tasks
- [ ] Great, I'll prepare the Option A proposal for Dana by Friday. — **due Friday**
- [ ] I'll also prepare a one-page ROI summary.
- [ ] Schedule a call with Dana for next week.

## Open questions and blockers
- Should I send the Option A proposal to Dana now, or wait for your pricing approval?
- Waiting on Acme procurement to confirm the PO number. _(blocker)_

## Needs confirmation (conflicting statements)
- “Always CC Dana's assistant Priya on scheduling emails.” vs “Never CC Dana's assistant Priya on scheduling emails.”

## Recent progress
- I updated the pricing sheet in /workspace/acme/pricing.xlsx with the new budget.

## Key knowledge
- The client's budget is now $55,000 per year after their Q3 review.
- Their main contact is Dana Whitfield (dana.whitfield@acme.example).
- The renewal record is CRM-4821 and the contract lives in /workspace/acme/contract-2025.pdf.

## Resources
`/workspace/acme/pricing.xlsx` · `/workspace/acme/contract-2025.pdf` · `CRM-4821` · `dana.whitfield@acme.example`

## Suggested next action
Resolve blocker: waiting on Acme procurement to confirm the PO number.

## Caveats
- Source coverage is unknown: this checkpoint only reflects material imported into GCM; Grok Bot may hold earlier context that is not represented here.
- 1 pair(s) of conflicting statements need confirmation.
- 1 passage(s) resembling instruction overrides were excluded from working context; review them in the archive.
- 1 item(s) contained secret-like values that were redacted.

## Not included
Older detail stays in the user’s local GCM archive (30 message(s), 1 import(s)). Don’t request it wholesale; ask the user, or use `gcm_search_archive` with a narrow query if that connector is enabled.

## Confirm load
Reply once with “Loaded GCM-F203-B4F2”, the objective in one sentence and the top three pending tasks; then wait for the user.