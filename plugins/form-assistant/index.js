import { requestAssistantResponse } from '../../common/openai.js';
import {
  addElementToCache,
  getCachedElement,
} from '../../common/plugin-element-cache.js';

const getSettings = (getPluginSettings) => {
  try {
    const settings = getPluginSettings?.();
    return typeof settings === 'string' ? JSON.parse(settings) : settings || {};
  } catch {
    return {};
  }
};

const getDefaultPrompts = (defaultPrompts) => {
  if (!Array.isArray(defaultPrompts)) return [];

  return defaultPrompts.filter(
    (item) =>
      item &&
      typeof item.title === 'string' &&
      item.title.trim() &&
      typeof item.prompt === 'string' &&
      item.prompt.trim(),
  );
};

const getFields = (contentType) => {
  const properties =
    contentType?.schemaDefinition?.allOf?.[1]?.properties || {};
  const propertiesConfig = contentType?.metaDefinition?.propertiesConfig || {};

  return Object.entries(properties).reduce((fields, [name, schema]) => {
    const config = propertiesConfig[name] || {};
    fields[name] = {
      schema,
      config,
      label: config.label || name,
      inputType: config.inputType || 'text',
      relationType: config.validation?.relationContenttype || null,
      relationMultiple: Boolean(config.validation?.relationMultiple),
    };
    return fields;
  }, {});
};

const extractRelationId = (item) => {
  if (typeof item === 'string') return item;
  if (item && typeof item.dataUrl === 'string') {
    return item.dataUrl.match(/[^/]+$/)?.[0] || null;
  }
  return null;
};

const getRelationCandidates = async (client, relationType) => {
  try {
    const response = await client[relationType]?.list({
      limit: 20,
      orderBy: 'internal.updatedAt',
      orderDirection: 'desc',
    });
    const data = response?.body?.data || response?.data || [];
    return data.map((object) => ({
      id: object.id,
      label: object.internal?.objectTitle || object.id,
    }));
  } catch {
    return [];
  }
};

const formatValue = (value) => {
  if (value === undefined) return 'Empty';
  if (typeof value === 'string') return value || 'Empty';

  return JSON.stringify(value);
};

const formatFieldValue = (value, field, candidatesByType) => {
  if (!field?.relationType) return formatValue(value);

  const ids = (Array.isArray(value) ? value : [])
    .map(extractRelationId)
    .filter(Boolean);
  if (!ids.length) return 'Empty';

  const candidates = candidatesByType.get(field.relationType) || [];
  return ids
    .map(
      (id) => candidates.find((candidate) => candidate.id === id)?.label || id,
    )
    .join(', ');
};

const isAllowedSelectValue = (value, config) => {
  if (config?.inputType !== 'select') return true;

  const options =
    config.optionsWithLabels?.map(({ value: option }) => option) ||
    config.options;
  if (!Array.isArray(options)) return true;

  return Array.isArray(value)
    ? value.every((item) => options.includes(item))
    : options.includes(value);
};

const isCompatibleValue = (value, schema, config) => {
  if (value === null) return true;
  if (!schema?.type) return true;
  if (!isAllowedSelectValue(value, config)) return false;
  if (schema.type === 'array') {
    return (
      Array.isArray(value) &&
      value.every((item) =>
        isCompatibleValue(item, schema.items, config?.items),
      )
    );
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (schema.type === 'object') {
    return (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.entries(value).every(([name, item]) => {
        const itemSchema = schema.properties?.[name];
        if (!itemSchema) return schema.additionalProperties !== false;

        return isCompatibleValue(
          item,
          itemSchema,
          config?.propertiesConfig?.[name],
        );
      })
    );
  }

  return typeof value === schema.type;
};

const isValidRelationValue = (value, field, candidatesByType) => {
  if (!Array.isArray(value)) return false;
  if (!field.relationMultiple && value.length > 1) return false;

  const candidateIds = new Set(
    (candidatesByType.get(field.relationType) || []).map(
      (candidate) => candidate.id,
    ),
  );
  const ids = value.map(extractRelationId);
  return ids.every((id) => id && candidateIds.has(id));
};

const toRelationValue = (value, field) =>
  value.map((item) => ({
    type: 'internal',
    dataUrl: `/api/v1/content/${field.relationType}/${extractRelationId(item)}`,
  }));

const getValidChanges = (changes, fields, candidatesByType) =>
  Array.isArray(changes)
    ? changes.reduce((valid, change) => {
        if (!change || typeof change.field !== 'string') return valid;
        const field = fields[change.field];
        if (!field) return valid;

        if (field.relationType) {
          if (!isValidRelationValue(change.value, field, candidatesByType))
            return valid;
          valid.push({
            ...change,
            value: toRelationValue(change.value, field),
          });
          return valid;
        }

        if (!isCompatibleValue(change.value, field.schema, field.config))
          return valid;
        valid.push(change);
        return valid;
      }, [])
    : [];

const valuesMatch = (currentValue, proposedValue) => {
  if (Object.is(currentValue, proposedValue)) return true;

  try {
    return JSON.stringify(currentValue) === JSON.stringify(proposedValue);
  } catch {
    return false;
  }
};

const relationValuesMatch = (currentValue, proposedValue) => {
  const currentIds = (Array.isArray(currentValue) ? currentValue : [])
    .map(extractRelationId)
    .filter(Boolean);
  const proposedIds = (Array.isArray(proposedValue) ? proposedValue : [])
    .map(extractRelationId)
    .filter(Boolean);
  return (
    currentIds.length === proposedIds.length &&
    currentIds.every((id) => proposedIds.includes(id))
  );
};

const getApplicableChanges = (changes, fields, form, candidatesByType) =>
  getValidChanges(changes, fields, candidatesByType).filter((change) => {
    const field = fields[change.field];
    const currentValue = form.getValue(change.field);
    return field.relationType
      ? !relationValuesMatch(currentValue, change.value)
      : !valuesMatch(currentValue, change.value);
  });

const createAssistantChat = ({ context, globals, client }) => {
  const { data } = context;
  const relationCandidatesCache = new Map();
  const chat = document.createElement('div');
  chat.className = 'ai-form-assistant-chat';
  chat.innerHTML = `
    <div class="ai-form-assistant-prompts" aria-label="Default prompts"></div>
    <div class="ai-form-assistant-messages" aria-live="polite"></div>
    <form class="ai-form-assistant-composer">
      <label class="ai-form-assistant-label" for="ai-form-assistant-message-${data.formUniqueKey}">
        Message
      </label>
      <textarea
        id="ai-form-assistant-message-${data.formUniqueKey}"
        name="message"
        rows="3"
        placeholder="e.g. Reduce the price by half"
        required
      ></textarea>
      <div class="ai-form-assistant-actions">
        <span class="ai-form-assistant-status"></span>
        <button type="submit" class="ai-form-assistant-send">Ask AI</button>
      </div>
    </form>
  `;

  const messages = chat.querySelector('.ai-form-assistant-messages');
  const form = chat.querySelector('.ai-form-assistant-composer');
  const textarea = chat.querySelector('textarea');
  const sendButton = chat.querySelector('.ai-form-assistant-send');
  const status = chat.querySelector('.ai-form-assistant-status');
  const prompts = chat.querySelector('.ai-form-assistant-prompts');
  let pendingChanges = [];

  const settings = getSettings(globals.getPluginSettings);
  if (!settings.openAiApiKey) {
    status.textContent = 'Paste an OpenAI API key in this plugin settings.';
  }

  getDefaultPrompts(settings.defaultPrompts).forEach(({ title, prompt }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-form-assistant-prompt';
    button.textContent = title;
    button.title = prompt;
    button.addEventListener('click', () => {
      textarea.value = prompt;
      form.requestSubmit();
    });
    prompts.appendChild(button);
  });

  if (!prompts.childElementCount) prompts.remove();

  const appendMessage = (role, text) => {
    const message = document.createElement('article');
    message.className = `ai-form-assistant-message ai-form-assistant-message-${role}`;
    const heading = document.createElement('strong');
    heading.textContent = role === 'assistant' ? 'AI agent' : 'You';
    const content = document.createElement('p');
    content.textContent = text;
    message.append(heading, content);
    messages.appendChild(message);
    messages.scrollTop = messages.scrollHeight;
  };

  const renderChanges = () => {
    chat.querySelector('.ai-form-assistant-changes')?.remove();
    const currentData = context.data;
    const fields = getFields(currentData.contentType);
    pendingChanges = getApplicableChanges(
      pendingChanges,
      fields,
      currentData.form,
      relationCandidatesCache,
    );
    if (!pendingChanges.length) return;

    const changes = document.createElement('section');
    changes.className = 'ai-form-assistant-changes';
    const title = document.createElement('h3');
    title.textContent = 'Proposed changes';
    const list = document.createElement('div');

    pendingChanges.forEach((change, index) => {
      const field = fields[change.field];
      const row = document.createElement('label');
      row.className = 'ai-form-assistant-change';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.value = String(index);
      const details = document.createElement('span');
      const value = document.createElement('span');
      value.className = 'ai-form-assistant-change-value';
      const currentValue = formatFieldValue(
        currentData.form.getValue(change.field),
        field,
        relationCandidatesCache,
      );
      value.textContent = `${field.label}: ${currentValue} -> ${formatFieldValue(
        change.value,
        field,
        relationCandidatesCache,
      )}`;
      const reason = document.createElement('small');
      reason.textContent = change.reason || 'Suggested by AI.';
      details.append(value, reason);
      row.append(checkbox, details);
      list.appendChild(row);
    });

    const applyButton = document.createElement('button');
    applyButton.type = 'button';
    applyButton.className = 'ai-form-assistant-apply';
    applyButton.textContent = 'Apply selected changes';
    applyButton.addEventListener('click', () => {
      const latestData = context.data;
      const latestFields = getFields(latestData.contentType);
      const selected = [...changes.querySelectorAll('input:checked')].map(
        (input) => Number(input.value),
      );
      const selectedChanges = getApplicableChanges(
        selected.map((index) => pendingChanges[index]),
        latestFields,
        latestData.form,
        relationCandidatesCache,
      );
      selectedChanges.forEach((change) =>
        latestData.form.setFieldValue(change.field, change.value),
      );
      pendingChanges = [];
      renderChanges();
      status.textContent = selectedChanges.length
        ? 'Selected changes were added to the form. Save the form to persist them.'
        : 'Select at least one change to apply.';
    });

    changes.append(title, list, applyButton);
    form.before(changes);
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = textarea.value.trim();
    const { openAiApiKey: apiKey, model } = getSettings(
      globals.getPluginSettings,
    );
    if (!message || !apiKey) {
      status.textContent = apiKey
        ? 'Write a message before sending it.'
        : 'Paste an OpenAI API key in this plugin settings.';
      return;
    }

    appendMessage('user', message);
    textarea.value = '';
    textarea.disabled = true;
    sendButton.disabled = true;
    status.textContent = 'AI is preparing a response...';

    try {
      const currentData = context.data;
      const fields = getFields(currentData.contentType);

      await Promise.all(
        Object.values(fields)
          .filter(
            (field) =>
              field.relationType &&
              !relationCandidatesCache.has(field.relationType),
          )
          .map(async (field) => {
            relationCandidatesCache.set(
              field.relationType,
              await getRelationCandidates(client, field.relationType),
            );
          }),
      );

      const fieldsForRequest = Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          field.relationType
            ? {
                ...field,
                candidates:
                  relationCandidatesCache.get(field.relationType) || [],
              }
            : field,
        ]),
      );

      const response = await requestAssistantResponse({
        apiKey,
        formValues: currentData.form.getValues(),
        fields: fieldsForRequest,
        message,
        model,
      });
      appendMessage(
        'assistant',
        response.reply || 'No response text was returned.',
      );
      pendingChanges = getApplicableChanges(
        response.changes,
        getFields(context.data.contentType),
        context.data.form,
        relationCandidatesCache,
      );
      renderChanges();
      status.textContent = pendingChanges.length
        ? 'Review and apply the proposed changes.'
        : 'No applicable form changes were proposed.';
    } catch (error) {
      status.textContent = error.message || 'The AI request failed. Try again.';
    } finally {
      textarea.disabled = false;
      sendButton.disabled = false;
      textarea.focus();
    }
  });

  return chat;
};

const createAssistantPanel = ({ context, globals, client }) => {
  const panel = document.createElement('section');
  panel.className = 'ai-form-assistant-panel';
  const title = document.createElement('h2');
  title.textContent = 'AI Assistant';
  const chat = createAssistantChat({ context, globals, client });
  panel.append(title, chat);
  return panel;
};

export const getOrCreateAssistantPanel = ({
  data,
  globals,
  pluginInfo,
  client,
  createPanel = createAssistantPanel,
  getCached = getCachedElement,
  addToCache = addElementToCache,
}) => {
  if (data.disabled || data.readonly) return null;

  const cacheKey = `${pluginInfo.id}:${data.formUniqueKey}`;
  const cached = getCached(cacheKey);
  if (cached) {
    cached.data.context.data = data;
    return cached.element;
  }

  const context = { data };
  const panel = createPanel({ context, globals, client });
  addToCache(panel, cacheKey, { context });
  return panel;
};

export const registerFormAssistant = (handler, client, globals, pluginInfo) => {
  handler.on('flotiq.form.sidebar-panel::add', (data) => {
    return getOrCreateAssistantPanel({ data, globals, pluginInfo, client });
  });
};
