# 10. Translate the sentence in progress the way an interpreter does: extend, do not rewrite

- Status: Accepted
- Decided: 2026-11-23
- Changes: #65, #66, #67, #69, #70; `docs/tuning.md`

## Context

Translating the sentence being spoken at a fixed interval rewrote the shown translation again and again. The aim was the least flicker without more delay, decided by measurement rather than by feel.

## Decision

The timing lives in `src/pacer.js` as named strategies that can be replayed against a recorded recognizer trace (`scripts/tuning/replay.mjs`). The default is `settle`: each request passes the translation already on screen and the model extends it (`carry`), and a finished sentence keeps the shown translation when it already covers the sentence, without another request. The translation model runs on the Standard tier; the priority tier was ruled out on cost.

## Consequences

- On the recorded meeting used for tuning, `carry` cut flicker from 0.93 to 0.20, and `settle` settled 27 of 58 sentences and lowered the mean final delay from 668 ms to 455 ms.
- The model's answer time varied between 0.6 s and 3.5 s by time of day, which is why strategies are compared in the same run (`--together`) and latency is measured in rounds. A claim in #67 that a request option made answers five times faster was measurement drift.
- A settled translation may lack the source's closing punctuation.
- A change to the strategies or the tools updates `docs/tuning.md`.
