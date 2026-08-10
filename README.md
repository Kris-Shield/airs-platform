# AIRS Platform v0.1 scaffold

Target Railway services:
- web
- api
- worker
- managed PostgreSQL

Access model:
- PUBLIC -> / and /visibility
- RESPONDENT -> /respond/:token
- CLIENT -> /portal/*
- AIRS_OPERATOR -> /airs-admin/*

Report policy:
- generated report enters READY_FOR_REVIEW
- AIRS operator approves explicitly
- client delivery occurs only after approval

Figma remains the UI source of truth. This scaffold establishes backend boundaries and Railway service structure.
