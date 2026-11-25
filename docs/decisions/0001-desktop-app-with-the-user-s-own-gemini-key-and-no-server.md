# 1. Desktop app with the user's own Gemini key and no server

- Status: Accepted
- Decided: 2026-11-21
- Changes: #7, #8, #9

## Context

Meeting speech is sensitive, and a service of our own would mean accounts, hosting costs and holding other people's recordings.

## Decision

Twinscript is an Electron desktop app for macOS and Windows that talks to the Gemini API directly with a key the user supplies. There is no Twinscript server. The page may load and connect only to what its content security policy lists.

## Consequences

- Speech goes to Google only, under the user's own account and billing.
- No sign-up, and nothing to operate.
- Every feature has to work from the client: anything that needs a secret other than the user's key, or shared state between devices (#29), has no place to live yet.
- The same interface still runs in a plain browser, which development and the browser tests rely on.
