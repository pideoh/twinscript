# 13. Summaries are made from templates, as Markdown, and all of them are kept

- Status: Accepted
- Decided: 2026-11-23
- Changes: #33, #75

## Context

The first summary was one short fixed format, and making a new one replaced the old.

## Decision

A summary is written by the translation model to a template (`{ id, name, description, prompt }`), a length and a language. Eight presets ship with the app; users can add, import and export their own. Each summary is stored as its own record and shown with a renderer that turns a safe subset of Markdown into HTML and shows everything else, raw HTML included, as text.

## Consequences

- Preset prompts are not translated; their names and descriptions are.
- Summaries made by earlier versions are shown through `legacySummaryToMarkdown`.
