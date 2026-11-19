# Documentation Rules for All AI Agents

## Mandatory startup reading

Every agent must read: - `README.md` -
`docs/00_PROJECT/PROJECT_OVERVIEW.md` -
`docs/00_PROJECT/PRODUCT_REQUIREMENTS.md` -
`docs/00_PROJECT/ARCHITECTURE.md` - `docs/00_PROJECT/DECISION_LOG.md` -
this file - its own agent prompt - all directly related
contracts/specifications

## Before coding

1.  Inspect repository and current implementation.
2.  Read latest progress files and changelog.
3.  Identify dependencies and contract assumptions.
4.  Report conflicts or missing decisions before making incompatible
    changes.
5.  Propose a short plan with files to change and tests.

## While coding

-   Do not overwrite work from another agent.
-   Keep changes within assigned scope.
-   Do not invent endpoints, fields, events or database columns.
-   Update contracts before or together with implementation changes.
-   Never silently change accepted ADRs.
-   Do not commit secrets, credentials, QR codes, personal data, or
    production session files.

## After each task

Update: - Relevant `*_PROGRESS.md`. - Relevant specification/contract
docs. - `CHANGELOG.md`. - `DECISION_LOG.md` only for approved
decisions. - Tests and evidence.

Every progress update must state: - Date. - Status. - Files
created/changed. - Implementation summary. - Commands/tests executed and
results. - Known limitations. - Blockers. - Next recommended task.

## Completion rule

A task is DONE only when implementation, tests, documentation and
evidence are present. If not tested, state `REVIEW` or `BLOCKED`, not
`DONE`.

## Handoff format

At the end of each agent run, provide: 1. Completed work. 2. Changed
files. 3. Contracts changed. 4. Tests and results. 5. Risks/limitations.
6. Next agent/task. 7. Exact docs updated.
