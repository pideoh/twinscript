// Summary templates: { id, name, description, prompt }. The prompt is free text telling the model
// which sections to write and what goes in each. Built-in presets are fixed (their names and
// descriptions are message keys, their prompts are English instructions like the translation
// prompt); custom ones are the user's, validated here whenever they are saved, loaded or imported.
// DOM-free: the app keeps the custom templates in localStorage. Template text is data: it is only
// ever shown as text and sent to the model inside the summary request's format section.
import { MessageError } from '../ui/message-error.js';

export const LIMITS = { name: 80, description: 200, prompt: 8000 };
export const MAX_TEMPLATES = 100; // custom templates kept; well inside the browser's storage quota
export const MAX_FILE_BYTES = 1_000_000; // an import file larger than this is refused unread
export const FILE_FORMAT = 'twinscript-summary-templates';
export const LENGTHS = ['short', 'standard', 'detailed'];
export const DEFAULT_TEMPLATE = 'preset:quick';

const preset = (key, prompt) => ({
  id: `preset:${key}`,
  preset: true,
  nameKey: `template.${key}.name`,
  descriptionKey: `template.${key}.description`,
  prompt,
});

export const PRESETS = [
  preset(
    'quick',
    `Write these sections:
## Overview
Two to four sentences on what the meeting was about and how it ended.
## Key points
Bullets with the main points discussed.
## Decisions
Bullets with what was agreed.
## Action items
Bullets in the form "task (owner, due date)", giving the owner and the due date only when the transcript names them.`,
  ),
  preset(
    'executive',
    `Write for a busy reader who was not in the meeting, conclusion first. Sections:
## Conclusion
The bottom line in one to three sentences.
## Background
Why the meeting took place and the situation it addressed.
## Main points discussed
Bullets.
## Decisions
Bullets with what was agreed.
## Risks and open questions
Bullets with the risks raised and the questions left unanswered.
## Next actions
Bullets with who does what next.`,
  ),
  preset(
    'minutes',
    `Write formal meeting minutes. Sections:
## Attendees
Only people who can be identified from the transcript, by name or role. Leave this section out if nobody can be identified.
## Discussion
One ### subsection per agenda item or topic, in the order discussed, with what was said and, where the transcript makes it clear, by whom.
## Decisions
Bullets with what was agreed.
## Action items
A table with the columns Task, Owner and Due date. Write "-" where the transcript does not say.
## Open issues
Bullets with what remains unresolved.
## Next meeting
Its date, time and topics if they were mentioned; otherwise say that it was not set.`,
  ),
  preset(
    'actions',
    `List only the action items: who does what by when. Write one bullet per task in the form "**Owner**: task (due date)", leaving out the owner or the due date when the transcript does not give them. Write nothing else: no overview, no headings, no other sections. If no tasks were agreed, write one sentence saying that there are no action items.`,
  ),
  preset(
    'customer',
    `Summarize a meeting with a customer from our side's point of view. Sections:
## Customer's situation and problems
Their context and the problems they described.
## Requests and concerns
What they asked for and what worries them.
## What was agreed
Bullets.
## Our follow-ups
Bullets with what we promised to do, with the owner and the due date when they were given.
## Next meeting
Its date and agenda if they were mentioned; otherwise say that it was not set.`,
  ),
  preset(
    'sales',
    `Summarize a sales call using the BANT framework. Sections:
## Context
Who the prospect is and why they are talking to us.
## Pain points
The problems they want to solve.
## Budget
What was said about budget or pricing.
## Authority
Who decides and who else is involved in the decision.
## Need
How strongly they need a solution and what it must do.
## Timeline
When they want to decide or start.
## Competitors mentioned
Other vendors or alternatives they named.
## Next steps
Bullets with the agreed follow-ups.
Write "Not discussed" under Budget, Authority, Need or Timeline when the transcript says nothing about it.`,
  ),
  preset(
    'oneOnOne',
    `Summarize a one-on-one meeting between a manager and a team member, in a supportive and neutral tone. Sections:
## What went well
## Difficulties
Problems, blockers or concerns that were raised.
## Feedback
Feedback given in either direction.
## Growth
Goals, skills and career topics that were discussed.
## Action items
Bullets with who does what by when.`,
  ),
  preset(
    'standup',
    `Summarize a stand-up meeting with short bullets, grouped by person when the transcript makes the speaker clear. Sections:
## Done
What was finished since the last stand-up.
## In progress
What people are working on now.
## Blockers
What is stopping someone, and who can help if that was mentioned. Write "None" when nobody reported a blocker.`,
  ),
];

export const isPreset = (id) => typeof id === 'string' && id.startsWith('preset:');
export const presetById = (id) => PRESETS.find((p) => p.id === id) ?? null;

// Custom template ids: letters, digits, "-" and "_" (a UUID fits), never the presets' prefix.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// Checks one custom template. `n` (1-based) names it in the error. A missing id is given one by
// `newId` when that is passed (a template written by hand), otherwise it is an error. Fields other
// than the four are ignored. Throws MessageError; returns { id, name, description, prompt }.
export function validateTemplate(raw, { n = 1, newId } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MessageError('templates.error.item', { n });
  let id = raw.id;
  if (id === undefined && newId) id = newId();
  if (typeof id !== 'string' || !ID.test(id)) throw new MessageError('templates.error.id', { n });
  const out = { id };
  for (const field of ['name', 'description', 'prompt']) {
    const value = raw[field] ?? (field === 'description' ? '' : undefined);
    if (typeof value !== 'string') throw new MessageError('templates.error.field', { n, field });
    const text = field === 'prompt' ? value.trim() : value.replace(/\s+/g, ' ').trim();
    if (!text && field !== 'description') throw new MessageError('templates.error.field', { n, field });
    if (text.length > LIMITS[field])
      throw new MessageError('templates.error.tooLong', { n, field, max: LIMITS[field] });
    out[field] = text;
  }
  return out;
}

// The stored list, keeping the templates that are still valid (a hand-edited or damaged entry is
// dropped rather than breaking the app).
export function readStoredTemplates(json) {
  let data;
  try {
    data = JSON.parse(json || 'null');
  } catch {
    return [];
  }
  const list = Array.isArray(data?.templates) ? data.templates : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    try {
      const template = validateTemplate(raw);
      if (seen.has(template.id)) continue;
      seen.add(template.id);
      out.push(template);
    } catch {
      /* dropped */
    }
  }
  return out.slice(0, MAX_TEMPLATES);
}

export const storedTemplatesJson = (templates) =>
  JSON.stringify({
    version: 1,
    templates: templates.map(({ id, name, description, prompt }) => ({ id, name, description, prompt })),
  });

// The export file: every custom template, as JSON.
export const exportTemplates = (templates) =>
  `${JSON.stringify(
    {
      format: FILE_FORMAT,
      version: 1,
      templates: templates.map(({ id, name, description, prompt }) => ({ id, name, description, prompt })),
    },
    null,
    2,
  )}\n`;

// Reads an export file. Everything in it must be valid, or nothing is imported. Throws MessageError.
export function parseTemplateFile(text, { newId } = {}) {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES)
    throw new MessageError('templates.error.tooLarge', { max: Math.round(MAX_FILE_BYTES / 1000) });
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new MessageError('templates.error.notJson');
  }
  if (
    !data ||
    typeof data !== 'object' ||
    data.format !== FILE_FORMAT ||
    data.version !== 1 ||
    !Array.isArray(data.templates)
  )
    throw new MessageError('templates.error.format');
  if (data.templates.length > MAX_TEMPLATES) throw new MessageError('templates.error.tooMany', { max: MAX_TEMPLATES });
  const templates = data.templates.map((raw, i) => validateTemplate(raw, { n: i + 1, newId }));
  const ids = new Set(templates.map((t) => t.id));
  if (ids.size !== templates.length) throw new MessageError('templates.error.duplicate');
  return templates;
}

// Merges imported templates into the existing ones by id: a template with a known id replaces it
// in place, a new one is added at the end. Throws when the result would hold too many.
export function mergeTemplates(existing, imported) {
  const out = existing.slice();
  let added = 0;
  let replaced = 0;
  for (const template of imported) {
    const at = out.findIndex((t) => t.id === template.id);
    if (at >= 0) {
      out[at] = template;
      replaced++;
    } else {
      out.push(template);
      added++;
    }
  }
  if (out.length > MAX_TEMPLATES) throw new MessageError('templates.error.tooMany', { max: MAX_TEMPLATES });
  return { templates: out, added, replaced };
}
