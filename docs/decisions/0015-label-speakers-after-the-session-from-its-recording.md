# 15. Label speakers after the session, from its recording

- Status: Accepted
- Decided: 2026-11-23
- Changes: #79; issue #21

## Context

The live transcription model does not separate speakers. The batch model does, but takes at most 30 minutes per request and numbers speakers afresh in each request.

## Decision

Speaker labels are added on request after a session ends. The recording is sent in parts of at most 25 minutes. From the second part on, a short reference clip of each speaker already known is put in front of the part, so the model's labels can be mapped to the session's speakers; the 60 seconds that consecutive parts share are a cross-check only. Where the mapping is not safe, the speaker is left unknown rather than guessed.

## Consequences

- No speaker names while listening.
- Costs one more pass over the recording with another model.
- Speakers are stored per segment (`speaker`), with their display names in the session's `speakerLabels`.
