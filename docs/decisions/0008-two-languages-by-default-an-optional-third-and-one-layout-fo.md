# 8. Two languages by default, an optional third, and one layout for both

- Status: Accepted
- Decided: 2026-11-23
- Changes: #51, #55, #57, #59, #61; issue #31

## Context

Meetings with three languages (typically Japanese, English and Chinese) are shown on a shared screen. A first layout with three translation lines per sentence was hard to read, and two- and three-language sessions looked different.

## Decision

A session has two languages unless a third is switched on. A sentence is shown in its own language and translated into the others, so a three-language session shows two translation lines. Every line, source and translation, starts with a fixed-width language code, and caption sentences are separated in both modes.

## Consequences

- A segment may carry `lang` and `tgts`; `tgt` stays the translations joined by line breaks, so older data and exports keep working.
- Left for later: export columns per language (#83) and the language read aloud (#84).
