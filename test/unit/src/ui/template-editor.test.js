import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEMPLATE, PRESETS } from '../../../../src/session/summary-templates.js';
import { createTemplateStore, TEMPLATES_KEY, upsertTemplate } from '../../../../src/ui/template-editor.js';

const t = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : `[${key}]`);
const mine = (id, name = `Name ${id}`) => ({ id, name, description: '', prompt: `Prompt ${id}` });

function memoryStorage(initial = {}) {
  const items = { ...initial };
  return {
    items,
    getItem: (name) => items[name] ?? null,
    setItem: (name, value) => {
      items[name] = value;
    },
  };
}
const stored = (...templates) => ({ [TEMPLATES_KEY]: JSON.stringify({ version: 1, templates }) });

test('custom templates saved before are there again when the app starts', () => {
  const templates = createTemplateStore({ storage: memoryStorage(stored(mine('a'), mine('b'))), t });
  assert.deepEqual(
    templates.custom().map((tpl) => tpl.id),
    ['a', 'b'],
  );
  assert.equal(templates.byId('b').name, 'Name b');
});

test('without readable storage the app starts with the presets only', () => {
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(createTemplateStore({ storage: blocked, t }).custom(), []);
  assert.deepEqual(createTemplateStore({ storage: memoryStorage({ [TEMPLATES_KEY]: '{oops' }), t }).custom(), []);
});

test('saved templates are written for the next start and used at once', () => {
  const storage = memoryStorage();
  const templates = createTemplateStore({ storage, t });
  templates.save([mine('a')]);
  assert.equal(templates.byId('a').prompt, 'Prompt a');
  assert.deepEqual(
    createTemplateStore({ storage, t })
      .custom()
      .map((tpl) => tpl.id),
    ['a'],
  );
});

test('templates the browser refuses to store stay as they were', () => {
  const storage = memoryStorage(stored(mine('a')));
  storage.setItem = () => {
    throw new Error('quota');
  };
  const templates = createTemplateStore({ storage, t });
  assert.throws(() => templates.save([mine('a'), mine('b')]), /quota/);
  assert.deepEqual(
    templates.custom().map((tpl) => tpl.id),
    ['a'],
  );
});

test('a template is found among the presets and the custom ones, and an unknown one is not', () => {
  const templates = createTemplateStore({ storage: memoryStorage(stored(mine('a'))), t });
  assert.equal(
    templates.byId(DEFAULT_TEMPLATE),
    PRESETS.find((p) => p.id === DEFAULT_TEMPLATE),
  );
  assert.equal(templates.byId('a').id, 'a');
  assert.equal(templates.byId('missing'), null);
});

test('presets are named in the display language, custom templates as the user wrote them', () => {
  const templates = createTemplateStore({ storage: memoryStorage(), t });
  const preset = PRESETS[0];
  assert.equal(templates.name(preset), `[${preset.nameKey}]`);
  assert.equal(templates.description(preset), `[${preset.descriptionKey}]`);
  const own = { ...mine('a', 'Weekly'), description: 'For Mondays' };
  assert.equal(templates.name(own), 'Weekly');
  assert.equal(templates.description(own), 'For Mondays');
});

test('saving an edited template replaces it in place; a new one goes at the end', () => {
  const list = [mine('a'), mine('b')];
  const edited = mine('a', 'Renamed');
  assert.deepEqual(upsertTemplate(list, edited), [edited, mine('b')]);
  assert.deepEqual(upsertTemplate(list, mine('c')), [mine('a'), mine('b'), mine('c')]);
  assert.deepEqual(list, [mine('a'), mine('b')], 'the list passed in is left as it was');
});
