// The user's own summary templates: where they are kept, and their editor in the settings dialog
// (list, new, duplicate, edit, delete, import and export). Validation and the file format are in
// src/session/summary-templates.js.

import {
  exportTemplates,
  MAX_FILE_BYTES,
  MAX_TEMPLATES,
  mergeTemplates,
  PRESETS,
  parseTemplateFile,
  presetById,
  readStoredTemplates,
  storedTemplatesJson,
  validateTemplate,
} from '../session/summary-templates.js';
import { MessageError } from './message-error.js';

// Custom templates are kept in localStorage under their own key, apart from the settings (which
// are rewritten on every change); at most MAX_TEMPLATES of at most ~8 KB each stay well inside
// the browser's quota for this origin.
export const TEMPLATES_KEY = 'rt-summary-templates';

// `list` with `template` in place of the one with its id, or added at the end when there is none.
export const upsertTemplate = (list, template) =>
  list.some((tpl) => tpl.id === template.id)
    ? list.map((tpl) => (tpl.id === template.id ? template : tpl))
    : [...list, template];

// The custom templates, read once from `storage` (a Storage-like object with getItem / setItem;
// unreadable or blocked storage gives none), and the names of all templates in the display
// language (`t`). DOM-free.
export function createTemplateStore({ storage, t }) {
  let custom = [];
  try {
    custom = readStoredTemplates(storage.getItem(TEMPLATES_KEY));
  } catch {
    /* private mode */
  }
  return {
    custom: () => custom,
    // Throws when the browser refuses to store them (quota, private mode); they stay as they were then.
    save(list) {
      storage.setItem(TEMPLATES_KEY, storedTemplatesJson(list));
      custom = list;
    },
    byId: (id) => presetById(id) ?? custom.find((tpl) => tpl.id === id) ?? null,
    name: (tpl) => (tpl.preset ? t(tpl.nameKey) : tpl.name),
    description: (tpl) => (tpl.preset ? t(tpl.descriptionKey) : tpl.description),
  };
}

// els: the page's elements; t: i18n; octicon(name): an icon; templates: a template store (above);
// uid(): a new id; errorText(err): an error's message; download(blob, name): saves a file;
// onTemplatesChanged(): the list of templates changed (the summary panel refills its select).
export function createTemplateEditor({ els, t, octicon, templates, uid, errorText, download, onTemplatesChanged }) {
  let editingTemplate = null; // { id } of the template in the editor; id null for a new one

  function showTemplateStatus(message, variant = 'info') {
    els.templateStatus.textContent = message;
    els.templateStatus.dataset.variant = variant;
    els.templateStatus.hidden = false;
  }

  function renderTemplateList() {
    const action = (icon, label, fn) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-btn';
      button.title = label.short;
      button.setAttribute('aria-label', label.full);
      button.append(octicon(icon));
      button.onclick = fn;
      return button;
    };
    const customTemplates = templates.custom();
    els.templateList.replaceChildren(
      ...[...PRESETS, ...customTemplates].map((tpl) => {
        const name = templates.name(tpl);
        const row = document.createElement('li');
        row.className = 'template-row';
        const text = document.createElement('div');
        text.className = 'template-text';
        const title = document.createElement('span');
        title.className = 'template-name';
        title.textContent = name;
        text.append(title);
        if (tpl.preset) {
          const badge = document.createElement('span');
          badge.className = 'label';
          badge.textContent = t('templates.builtIn');
          text.append(' ', badge);
        }
        const description = templates.description(tpl);
        if (description) {
          const line = document.createElement('span');
          line.className = 'template-description';
          line.textContent = description;
          text.append(line);
        }
        const acts = document.createElement('div');
        acts.className = 'template-acts';
        const label = (key, full) => ({ short: t(key), full: t(full, { name }) });
        acts.append(
          action('copy', label('templates.duplicate', 'templates.duplicateOf'), () => openTemplateEditor(tpl, true)),
        );
        if (!tpl.preset)
          acts.append(
            action('pencil', label('templates.edit', 'templates.editOf'), () => openTemplateEditor(tpl)),
            action('trash', label('templates.delete', 'templates.deleteOf'), () => deleteTemplate(tpl)),
          );
        row.append(text, acts);
        return row;
      }),
    );
    els.templateExport.disabled = !customTemplates.length;
    els.templateNew.disabled = customTemplates.length >= MAX_TEMPLATES;
  }

  // tpl: the template to edit, or to start from when `copy` (a duplicate); none for a new one.
  function openTemplateEditor(tpl, copy = false) {
    editingTemplate = { id: tpl && !copy ? tpl.id : null };
    els.templateEditorTitle.textContent = t(editingTemplate.id ? 'templates.editTitle' : 'templates.newTitle');
    els.templateName.value = tpl
      ? (copy ? t('templates.copyName', { name: templates.name(tpl) }) : tpl.name).slice(0, els.templateName.maxLength)
      : '';
    els.templateDescription.value = tpl ? templates.description(tpl) : '';
    els.templatePrompt.value = tpl?.prompt ?? '';
    els.templateError.hidden = true;
    els.templateStatus.hidden = true;
    els.templateEditor.hidden = false;
    els.templateEditor.scrollIntoView({ block: 'nearest' });
    els.templateName.focus();
  }
  function closeTemplateEditor() {
    editingTemplate = null;
    els.templateEditor.hidden = true;
  }
  function templatesChanged() {
    onTemplatesChanged();
    renderTemplateList();
  }

  els.templateNew.onclick = () => openTemplateEditor(null);
  els.templateCancel.onclick = () => {
    closeTemplateEditor();
    els.templateNew.focus();
  };
  // Enter in a one-line field would submit the settings form and close the dialog.
  for (const input of [els.templateName, els.templateDescription]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
  }
  els.templateSave.onclick = () => {
    const error = (message) => {
      els.templateError.textContent = message;
      els.templateError.hidden = false;
    };
    if (!els.templateName.value.trim()) return error(t('templates.nameRequired'));
    if (!els.templatePrompt.value.trim()) return error(t('templates.promptRequired'));
    let template;
    try {
      template = validateTemplate({
        id: editingTemplate?.id ?? uid(),
        name: els.templateName.value,
        description: els.templateDescription.value,
        prompt: els.templatePrompt.value,
      });
    } catch (err) {
      return error(errorText(err));
    }
    const list = upsertTemplate(templates.custom(), template);
    try {
      if (list.length > MAX_TEMPLATES) throw new MessageError('templates.error.tooMany', { max: MAX_TEMPLATES });
      templates.save(list);
    } catch (err) {
      return error(t('templates.saveFailed', { message: errorText(err) }));
    }
    closeTemplateEditor();
    templatesChanged();
    showTemplateStatus(t('templates.saved', { name: template.name }));
    els.templateNew.focus();
  };

  function deleteTemplate(tpl) {
    if (!confirm(t('templates.deleteConfirm', { name: tpl.name }))) return;
    try {
      templates.save(templates.custom().filter((x) => x.id !== tpl.id));
    } catch (err) {
      return showTemplateStatus(t('templates.saveFailed', { message: errorText(err) }), 'critical');
    }
    if (editingTemplate?.id === tpl.id) closeTemplateEditor();
    templatesChanged();
    showTemplateStatus(t('templates.deleted', { name: tpl.name }));
    els.templateNew.focus();
  }

  els.templateExport.onclick = () => {
    const customTemplates = templates.custom();
    if (!customTemplates.length) return;
    download(
      new Blob([exportTemplates(customTemplates)], { type: 'application/json' }),
      'twinscript-summary-templates.json',
    );
  };
  els.templateImport.onclick = () => els.templateImportFile.click();
  els.templateImportFile.onchange = async () => {
    const file = els.templateImportFile.files[0];
    els.templateImportFile.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_FILE_BYTES)
        throw new MessageError('templates.error.tooLarge', { max: Math.round(MAX_FILE_BYTES / 1000) });
      const imported = parseTemplateFile(await file.text(), { newId: uid });
      const { templates: merged, added, replaced } = mergeTemplates(templates.custom(), imported);
      templates.save(merged);
      templatesChanged();
      showTemplateStatus(t('templates.imported', { added, replaced }));
    } catch (err) {
      showTemplateStatus(t('templates.importFailed', { message: errorText(err) }), 'critical');
    }
  };

  return { renderList: renderTemplateList, close: closeTemplateEditor };
}
