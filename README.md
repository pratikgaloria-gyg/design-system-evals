# design-system-evals

Tooling for the **AI-Enabled UX Delivery** evals pilot (Jira UDS-461 → UDS-468).
Takes the self-reported trace a Claude Design session writes to Confluence and lands it in
Braintrust project logs, so Rita's rubric can score it.

```
Claude Design session ──(skill, on "close session")──▶ Confluence page   ──(ingest, cron)──▶ Braintrust logs
                                                      readable + JSON        JSON block only
```

TypeScript, zero runtime dependencies (Node ≥ 20 `fetch`, `node:test`). Dev deps: `typescript`, `tsx`, `@types/node`.

## Layout

| Path | What |
| --- | --- |
| `schema/trace.schema.json` | Trace format v0.4 (UDS-465). Single source of truth; the skill cites it by version. |
| `src/types.ts` | `Trace` and `BraintrustEvent` types. Keep in sync with the schema. |
| `src/schema.ts` | Small JSON-Schema validator (type/required/properties/items/enum). Swap for ajv if it outgrows this. |
| `src/trace.ts` | Normalise legacy v0.3 field names, map a trace to a Braintrust event. |
| `src/confluence.ts` | List session pages under the pilot parent, extract the JSON code block (ADF or storage format). |
| `src/braintrust.ts` | `POST /v1/project_logs/{project_id}/insert` on the EU data plane. |
| `src/renderPage.ts` | Render a trace as a Confluence page body (readable sections + JSON block). |
| `src/cli.ts` | `validate`, `render`, `push`, `run`. |
| `skills/ai-ux-delivery-trace/SKILL.md` | The user-attached Claude Design skill (v0.5) that writes the page. |
| `tests/` | Offline tests against the fixture trace(s). |
| `.github/workflows/ingest.yml` | Manual dispatch now; cron sweep in Phase 3. |

## Conventions (the contract between skill and ingest)

1. One Confluence page per session, child of the pilot parent page, **title = `session_id`**.
2. The page ends with exactly one code block, language `json`, containing the full trace.
   `ingest run` parses the *last* json code block whose object has a `session_id`. Prose is ignored.
3. The readable part is rendered from the JSON (`renderPage.ts`). Never hand-edit it; fix the JSON and re-render.
4. Braintrust event `id` = `session_id`, so re-running is an upsert. Duplicate `session_id`s across pages get a
   `__p<pageId>` suffix and a warning — the skill must mint unique IDs.
5. No `scores` are written. `self_assessed_compliant` is the model's belief, not a compliance score (UDS-465).

Braintrust mapping: `input` = `brief`, `output` = design_system / coverage / accessibility / artifacts / history,
`metadata` = flat fields for filtering (status, turns, corrections, deviation counts, skill version, Confluence page).

## Setup

```bash
npm install
cp .env.example .env   # fill in BRAINTRUST_API_KEY, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN
npm test
npm run typecheck
```

Secrets stay in `.env` (git-ignored) locally and in GitHub Actions secrets in CI. Never commit a key.

## Use

```bash
# Phase 0 exit: push one local trace straight to Braintrust
npm run ingest -- push tests/fixtures/traveler-onboarding-carousel.json --dry-run
npm run ingest -- push tests/fixtures/traveler-onboarding-carousel.json

# Render a trace as a Confluence page body (what the skill produces)
npm run ingest -- render tests/fixtures/traveler-onboarding-carousel.json > page.html

# Ingest every session page under the pilot parent
npm run ingest -- run --dry-run
npm run ingest -- run
npm run ingest -- run --page 4927390328   # one page
```

## Roadmap

- [x] Format v0.4, user-attached skill, Confluence logging proven (UDS-465/466)
- [ ] Phase 0 — one trace visible in Braintrust via `push`
- [ ] Phase 2 — `run` ingests all pilot pages; skill v0.5 writes the page on close
- [ ] Phase 3 — cron sweep, service token, idle/abandoned tagging, alerts
- [ ] Phase 4 — UDS-467 verifier alongside the self-report
