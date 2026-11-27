# Principles

What Twinscript is built on. When a choice is not covered by a rule, decide it from these. When a rule and a
principle disagree, the rule is wrong: fix the rule.

Each principle says what it means in practice, so that two people (or two sessions) facing the same question
arrive at the same answer.

## The product

**1. The meeting stays between the user and the model they chose.**
There is no Twinscript server. The app runs on the user's own API key; transcripts, recordings and settings
stay on their computer. Every place the app connects to is named in the README, and a new one is a decision of
its own, never a side effect of a feature.

**2. The reader is never made to read something twice.**
Text that has been shown is extended, not rewritten. Notices do not interrupt, steal focus or cover the
transcript. The screen looks and behaves the same in every mode, so nothing has to be relearned.

**3. "Unknown" is better than a guess.**
When the app cannot tell (who spoke, which language, what something cost), it says so or leaves it empty. An
estimate is labelled as an estimate. A wrong answer shown with confidence costs the user more than a gap.

**4. What cannot be tried is not shipped.**
A feature is released when it has been run against the real thing it depends on. What could not be verified is
said plainly, in the pull request and to the user, not assumed to work.

## The work

**5. Measure, then decide.**
A choice about speed, quality or cost is made from numbers taken under the same conditions, with the tool kept
in the repository so the measurement can be repeated. A claim that was not measured is not written down as a
fact.

**6. What is in the repository is what runs.**
No build step, and nothing downloaded by name at run time. The code that runs is the project's own, plus only
what the repository names exactly: a runtime dependency is an exception, decided and recorded on its own, pinned
to one version, shipped as its author published it, reached through a single module, and limited to what the
platform cannot do. None is added for convenience. What a library would otherwise have provided is written here
and tested, small enough to read.

**7. A rule that matters is a check.**
If breaking a rule can be detected, a test or a CI job detects it. Prose is for what cannot be checked: intent,
taste and judgment. A rule that exists only as prose is a rule that will be broken unnoticed.

**8. One place for each thing.**
Each fact and each rule is written once, where the person who needs it will look, and everything else points
there. The folder says what a file is; the first comment of a file says what it is for; a test sits where its
subject sits.

**9. Logic can be run without the screen.**
What the app decides is separate from how it is shown: logic takes what it needs as arguments and runs under a
plain test runner. The screen reads the page and calls it.

**10. One change does one thing.**
A move does not fix, a fix does not tidy, a feature does not refactor. Each change can be described in one
line, verified on its own and undone on its own. What is noticed on the way becomes an issue.

**11. Words describe what exists.**
The README, the docs, pull requests and release notes describe the product as it is after the change: not the
plan, not the path that led there, not what was considered. Reasons for a costly choice are recorded once, as a
decision, and the rest is history kept by git.

**12. Secrets and speech do not travel.**
An API key never appears in a command, a file, a test or a log. Recordings, traces and anything else that holds
what people said stay on the machine they were made on.
