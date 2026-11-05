# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository is a **QA Automation Framework** (Playwright + TypeScript) for requirement-driven, human-approved test automation. It turns a plain-language business requirement into traced test cases, routes them through a human Approval Gate, then (only after approval) explores the real UI with Playwright MCP, writes automation, runs it under an Environment/Write Safety policy, and produces a QA Report with evidence.

The primary entry point for a user is the `/qa-requirement` slash command (`.claude/commands/qa-requirement.md`). Full documentation: `README.md` (quick start), `INSTALL.md` (detailed setup), `FRAMEWORK.md` (complete reference).

The project uses the official `@playwright/mcp` for live UI exploration, declared in `.mcp.json`.

## Setup & Installation

```bash
npm install
npx playwright install chromium
npm run setup -- --init     # creates .env from .env.example, lists missing variable NAMES only
# fill in .env once, then:
npm run setup                # should report "ready"
```

Then open the project in Claude Code and run `/qa-requirement`. See `README.md`/`INSTALL.md` for the full flow (requirement → test case → Approval Gate → environment/write confirmation → automation → QA Report).

## Key commands

- `npm run typecheck` / `npm run test:framework` — static check + framework's own tests (no external connection). Run these before anything else.
- `npm test` — **not a toy test runner.** It is the QA framework's gated business-test runner (`scripts/run-tests.ts`): it refuses to run without a valid Approval Gate + confirmed environment, and by default is read-only against whatever application/environment is configured in `.env`/`environments/`. `npm run test:write` enables write-enabled runs (still gated, framework-owned data only).
- `npm run qa:next` — read-only status check that tells you (and a human) what the next step of the `/qa-requirement` workflow is.
- `npm run report:rebuild` / `npm run report:verify` — rebuild the QA Report from stored results and cross-check JSON/HTML/summary agree.
- `npm run security:scan` — read-only scan for secret leakage outside `.env`/`.auth` (never prints secret values).

Do not run `npm test` / `npm run test:write` speculatively — they are gated by design (Approval Gate, environment confirmation, write-policy confirmation) and, when not blocked, can create or modify data on whatever real application is configured. See `FRAMEWORK.md` for the full safety model before touching any of this.

## Architecture (QA framework)

- `core/` — safety and workflow engine (Approval Gate, environment/write policy, Test Data Factory + registry, cleanup engine, QA reporter), application-agnostic.
- `applications/<app>/` — per-application adapter (currently `odoo/`), split into `modules/<module>/` (Page Objects, API, recipes) per business module.
- `requirements/`, `testcases/`, `automation/`, `approvals/` — requirement text (locked verbatim), generated test cases, execution metadata, and signed approval records.
- `tests/framework/` — the framework's own tests (safe to run anywhere, no external connection). `tests/<app>-<module>/` — generated business test specs (only exist once a module has been automated).
- `.claude/commands/qa-requirement.md` — the orchestration the `/qa-requirement` command follows.
