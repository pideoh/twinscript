# 11. Store one record per sentence and load a transcript only when its session is opened

- Status: Accepted
- Decided: 2026-11-23
- Changes: #71, #75; issue #25

## Context

Each save rewrote the whole session, transcript included, and the session list loaded every transcript. Memory and save time grew with the length of a meeting.

## Decision

IndexedDB `twinscript` version 3 has `sessions` (metadata and a count), `segments` (one record per sentence, key `[sessionId, pos]`), `summaries` (key `[sessionId, id]`) and `audio` (recording chunks). A save writes only the segments that changed. The upgrade moves existing transcripts out of the session records and cannot be undone.

## Consequences

- An older version of the app cannot read data once it has been upgraded.
- A second open window blocks the upgrade; the app says so.
- Daily usage totals and custom summary templates live in `localStorage`, so they survive deleting sessions.
