# 7. Decide the translation direction from the writing system where it is clear

- Status: Accepted
- Decided: 2026-11-21
- Changes: #42, #54, #57

## Context

Asking the model which language a sentence is in, or letting it choose the direction, went wrong for short utterances and for speech in a language that was not selected.

## Decision

When the selected languages use different writing systems, the direction is decided locally from the transcript's script (`src/script-hint.js`) and the request fixes the target with `into`. The model is asked to identify the language (`identify`) only in three-language sessions where the script does not settle it. Speech in a language that is not selected is translated into all selected languages.

## Consequences

- No extra request, and no wrong direction, for pairs such as Japanese and English.
- Pairs in the same script (English and French) still rely on the model.
