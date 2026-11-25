# 14. Show usage per session and estimate its cost in US dollars

- Status: Accepted
- Decided: 2026-11-23
- Changes: #73, #77

## Context

Users pay Google directly and had no view of what a meeting costs.

## Decision

Each session carries a usage record: listening time, and requests and tokens as reported in `usageMetadata` (thinking counted as output). Cost is that usage times a price table in `src/pricing.js` (paid tier, Standard), shown in US dollars only and labelled an estimate. Transcription is estimated from listening time and a per-minute price. A monthly workflow compares the table with Google's pricing page and proposes changes as a pull request; it never merges them.

## Consequences

- The estimate can differ from the bill, most of all for transcription.
- Daily totals are kept apart from sessions, so deleting a session does not lower them.
- `LIVE_MODEL` in `src/usage-stats.js` must follow the model in `src/transcriber.js`; a unit test checks it.
