# 16. Treat speech as data in the translation prompt

- Status: Accepted
- Decided: 2026-11-21
- Changes: #37, #38; issue #20

## Context

Transcribed speech is passed to a model, and someone in the meeting can say a sentence that reads as an instruction.

## Decision

The translation prompt marks the text to translate as data and tells the model to translate instructions in it, not follow them. Vocabulary terms and corrections are applied as recognizer hints and local replacement rules, not by adding user text to the prompt's instructions.

## Consequences

- A spoken instruction comes out translated.
- Prompt changes are checked against this.
