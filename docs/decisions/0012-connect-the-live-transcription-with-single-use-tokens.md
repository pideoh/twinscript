# 12. Connect the live transcription with single-use tokens

- Status: Accepted
- Decided: 2026-11-23
- Changes: #74; issue #26

## Context

A browser WebSocket cannot send headers, so the API key travelled in the connection's address, where proxies and logs can record it. Keys were being flagged after use.

## Decision

Before each connection the app requests a single-use token (`auth_tokens`, with the key in a request header) and opens the WebSocket with that token. If the token service has never answered in a run, the connection falls back to the key in the address and logs a warning.

## Consequences

- The key itself is sent in headers only in normal use.
- One extra request per connection, including each rotation before the 10-minute session limit.
