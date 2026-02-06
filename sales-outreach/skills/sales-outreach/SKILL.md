---
name: sales-outreach
description: Execute sales and outreach workflows with strict approval gating, call qualification, and audit-ready artifacts.
---

## Auth/Env
- RETELL_API_KEY
- RETELL_FROM_NUMBER
- RETELL_AGENT_ID
- HUNTER_API_KEY
- APOLLO_API_KEY
- APOLLO_BASE_URL
- GMAIL_CREDENTIALS_PATH

## Primary Workflows
- workflows:sales-outreach:run-daily-revenue-cycle
- workflows:sales-outreach:prepare-approval-batch
- workflows:sales-outreach:launch-voice-qualification

## Bundled Skills

### Voice Qualification
- skills/retell-calls — AI-powered outbound calls via Retell API with ESG lead qualification and CRM webhook integration
