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
    };
    return fields;
  }, {});
};

const formatValue = (value) => {
  if (value === undefined) return 'Empty';
  if (typeof value === 'string') return value || 'Empty';

  return JSON.stringify(value);
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

const getValidChanges = (changes, fields) =>
  Array.isArray(changes)
    ? changes.filter(
        (change) =>
          change &&
          typeof change.field === 'string' &&
          fields[change.field] &&
          isCompatibleValue(
            change.value,
            fields[change.field].schema,
            fields[change.field].config,
          ),
      )
    : [];

const valuesMatch = (currentValue, proposedValue) => {
  if (Object.is(currentValue, proposedValue)) return true;

  try {
    return JSON.stringify(currentValue) === JSON.stringify(proposedValue);
  } catch {
    return false;
  }
};

const getApplicableChanges = (changes, fields, form) =>
  getValidChanges(changes, fields).filter(
    (change) => !valuesMatch(form.getValue(change.field), change.value),
  );

const createAssistantChat = ({ context, globals }) => {
  const { data } = context;
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
      const currentValue = formatValue(currentData.form.getValue(change.field));
      value.textContent = `${field.label}: ${currentValue} -> ${formatValue(
        change.value,
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
    const apiKey = getSettings(globals.getPluginSettings).openAiApiKey;
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
      const response = await requestAssistantResponse({
        apiKey,
        formValues: currentData.form.getValues(),
        fields,
        message,
      });
      appendMessage(
        'assistant',
        response.reply || 'No response text was returned.',
      );
      pendingChanges = getApplicableChanges(
        response.changes,
        getFields(context.data.contentType),
        context.data.form,
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

const createAssistantPanel = ({ context, globals }) => {
  const panel = document.createElement('section');
  panel.className = 'ai-form-assistant-panel';
  const title = document.createElement('h2');
  title.textContent = 'AI Assistant';
  const chat = createAssistantChat({ context, globals });
  panel.append(title, chat);
  return panel;
};

export const getOrCreateAssistantPanel = ({
  data,
  globals,
  pluginInfo,
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
  const panel = createPanel({ context, globals });
  addToCache(panel, cacheKey, { context });
  return panel;
};

export const registerFormAssistant = (handler, globals, pluginInfo) => {
  handler.on('flotiq.form.sidebar-panel::add', (data) => {
    return getOrCreateAssistantPanel({ data, globals, pluginInfo });
  });
};
