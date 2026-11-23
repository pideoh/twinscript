import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogs } from '../src/i18n.js';
import {
  DEFAULT_TEMPLATE,
  exportTemplates,
  FILE_FORMAT,
  LIMITS,
  MAX_TEMPLATES,
  mergeTemplates,
  PRESETS,
  parseTemplateFile,
  readStoredTemplates,
  storedTemplatesJson,
  validateTemplate,
} from '../src/summary-templates.js';

const mine = {
  id: 'mine-1',
  name: 'Board meeting',
  description: 'For the board',
  prompt: '## Decisions\nWhat was agreed.',
};
const rejects = (fn, key, params) =>
  assert.throws(fn, (err) => {
    assert.equal(err.key, key);
    if (params) assert.deepEqual(err.params, params);
    return true;
  });

test('the eight presets name their sections and have a translated name and description', () => {
  assert.deepEqual(
    PRESETS.map((p) => p.id),
    [
      'preset:quick',
      'preset:executive',
      'preset:minutes',
      'preset:actions',
      'preset:customer',
      'preset:sales',
      'preset:oneOnOne',
      'preset:standup',
    ],
  );
  assert.ok(PRESETS.some((p) => p.id === DEFAULT_TEMPLATE));
  for (const p of PRESETS) {
    assert.ok(p.prompt.length > 40 && p.prompt.length <= LIMITS.prompt, p.id);
    for (const [locale, catalog] of Object.entries(catalogs())) {
      assert.ok(catalog[p.nameKey], `${locale} ${p.nameKey}`);
      assert.ok(catalog[p.descriptionKey], `${locale} ${p.descriptionKey}`);
    }
  }
  const quick = PRESETS[0].prompt;
  for (const section of ['Overview', 'Key points', 'Decisions', 'Action items'])
    assert.ok(quick.includes(`## ${section}`));
  const sales = PRESETS.find((p) => p.id === 'preset:sales').prompt;
  for (const section of [
    'Pain points',
    'Budget',
    'Authority',
    'Need',
    'Timeline',
    'Competitors mentioned',
    'Next steps',
  ])
    assert.ok(sales.includes(`## ${section}`), section);
});

test('a custom template is checked for its shape and sizes', () => {
  assert.deepEqual(
    validateTemplate({ ...mine, name: '  Board\n meeting ', extra: 1 }),
    mine,
    'trimmed; other fields ignored',
  );
  assert.deepEqual(validateTemplate({ id: 'x', name: 'N', prompt: 'P' }), {
    id: 'x',
    name: 'N',
    description: '',
    prompt: 'P',
  });
  assert.equal(validateTemplate({ name: 'N', prompt: 'P' }, { newId: () => 'new-id' }).id, 'new-id');

  rejects(() => validateTemplate(null, { n: 2 }), 'templates.error.item', { n: 2 });
  rejects(() => validateTemplate([mine]), 'templates.error.item');
  rejects(() => validateTemplate({ ...mine, id: undefined }), 'templates.error.id');
  rejects(() => validateTemplate({ ...mine, id: 'preset:quick' }), 'templates.error.id', { n: 1 });
  rejects(() => validateTemplate({ ...mine, id: '../x' }), 'templates.error.id');
  rejects(() => validateTemplate({ ...mine, name: '   ' }), 'templates.error.field', { n: 1, field: 'name' });
  rejects(() => validateTemplate({ ...mine, prompt: 42 }), 'templates.error.field', { n: 1, field: 'prompt' });
  rejects(() => validateTemplate({ ...mine, description: {} }), 'templates.error.field', {
    n: 1,
    field: 'description',
  });
  assert.equal(validateTemplate({ ...mine, name: 'n'.repeat(LIMITS.name) }).name.length, 80);
  rejects(() => validateTemplate({ ...mine, name: 'n'.repeat(81) }, { n: 3 }), 'templates.error.tooLong', {
    n: 3,
    field: 'name',
    max: 80,
  });
  rejects(() => validateTemplate({ ...mine, description: 'd'.repeat(201) }), 'templates.error.tooLong');
  assert.equal(validateTemplate({ ...mine, prompt: 'p'.repeat(8000) }).prompt.length, 8000);
  rejects(() => validateTemplate({ ...mine, prompt: 'p'.repeat(8001) }), 'templates.error.tooLong', {
    n: 1,
    field: 'prompt',
    max: 8000,
  });
});

test('custom templates export to a file that imports back unchanged', () => {
  const other = { id: 'mine-2', name: '<b>HTML</b> name', description: '', prompt: '<script>alert(1)</script>' };
  const file = exportTemplates([mine, other]);
  const data = JSON.parse(file);
  assert.equal(data.format, FILE_FORMAT);
  assert.equal(data.version, 1);
  assert.deepEqual(parseTemplateFile(file), [mine, other], 'markup is kept as text, not interpreted');
  assert.deepEqual(parseTemplateFile(`﻿${file}`), [mine, other], 'a byte order mark is ignored');
});

test('an import file that is not an export, or has one bad template, is refused as a whole', () => {
  const file = (templates, extra = {}) => JSON.stringify({ format: FILE_FORMAT, version: 1, templates, ...extra });
  rejects(() => parseTemplateFile('not json'), 'templates.error.notJson');
  rejects(() => parseTemplateFile('[]'), 'templates.error.format');
  rejects(() => parseTemplateFile(JSON.stringify({ templates: [mine] })), 'templates.error.format');
  rejects(() => parseTemplateFile(file([mine], { version: 2 })), 'templates.error.format');
  rejects(() => parseTemplateFile(file({ 0: mine })), 'templates.error.format');
  rejects(() => parseTemplateFile(file([mine, { ...mine, id: 'b', prompt: '' }])), 'templates.error.field', {
    n: 2,
    field: 'prompt',
  });
  rejects(() => parseTemplateFile(file([mine, mine])), 'templates.error.duplicate');
  rejects(
    () => parseTemplateFile(file(Array.from({ length: MAX_TEMPLATES + 1 }, (_, i) => ({ ...mine, id: `t${i}` })))),
    'templates.error.tooMany',
  );
  rejects(() => parseTemplateFile('x'.repeat(1_000_001)), 'templates.error.tooLarge', { max: 1000 });
  assert.equal(parseTemplateFile(file([{ name: 'N', prompt: 'P' }]), { newId: () => 'given' })[0].id, 'given');
});

test('an import is merged by id: known ids are replaced in place, new ones added', () => {
  const a = { ...mine, id: 'a' };
  const b = { ...mine, id: 'b' };
  const { templates, added, replaced } = mergeTemplates(
    [a, b],
    [
      { ...a, name: 'Renamed' },
      { ...mine, id: 'c' },
    ],
  );
  assert.deepEqual(
    templates.map((t) => [t.id, t.name]),
    [
      ['a', 'Renamed'],
      ['b', mine.name],
      ['c', mine.name],
    ],
  );
  assert.deepEqual([added, replaced], [1, 1]);
  const full = Array.from({ length: MAX_TEMPLATES }, (_, i) => ({ ...mine, id: `t${i}` }));
  rejects(() => mergeTemplates(full, [{ ...mine, id: 'one-more' }]), 'templates.error.tooMany');
  assert.equal(mergeTemplates(full, [{ ...mine, id: 't0' }]).templates.length, MAX_TEMPLATES, 'replacing is fine');
});

test('stored templates survive a reload; damaged entries are dropped', () => {
  const json = storedTemplatesJson([mine, { ...mine, id: 'b' }]);
  assert.deepEqual(readStoredTemplates(json), [mine, { ...mine, id: 'b' }]);
  const damaged = JSON.stringify({ version: 1, templates: [mine, { id: 'x' }, null, mine, 'text'] });
  assert.deepEqual(readStoredTemplates(damaged), [mine]);
  assert.deepEqual(readStoredTemplates(null), []);
  assert.deepEqual(readStoredTemplates('{bad'), []);
});
