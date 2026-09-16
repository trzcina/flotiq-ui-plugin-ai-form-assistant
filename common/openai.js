const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export const DEFAULT_MODEL = 'gpt-4.1-mini';

const getResponseText = (response) => {
  if (typeof response.output_text === 'string') return response.output_text;

  return response.output
    ?.flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text)
    .join('');
};

export const requestAssistantResponse = async ({
  apiKey,
  formValues,
  fields,
  message,
  model,
  history = [],
}) => {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      instructions: [
        'You are an assistant editing one Flotiq content form.',
        'Use only fields defined in the provided schema.',
        'Return only valid JSON with this exact shape:',
        '{"reply":"string","changes":[{"field":"fieldName","valueJson":"JSON-encoded value","reason":"string"}]}',
        'For every change, encode the new field value with JSON.stringify and put the result in valueJson.',
        'For select fields, use only values listed in their options configuration, including nested fields.',
        'For relation fields with a candidates list, valueJson is a JSON array of ids from that list only.',
        'Never invent a relation id or use the {type,dataUrl} shape.',
        'If no candidate matches what the user asked for, omit that field from changes entirely.',
        'Only propose an empty array for a relation field when the user explicitly asked to clear it.',
        'For floating-point number fields, use no more than two decimal places.',
        'Do not include a change when its proposed value is equal to the current field value.',
        'Use an empty changes array when no form change is needed.',
        'Earlier user/assistant turns are prior conversation context only.',
        'Only the latest user turn carries the current formValues/fields JSON to act on.',
        'Never repeat a change from an earlier turn; each reply is a fresh proposal about current formValues.',
      ].join(' '),
      input: [
        ...history.flatMap(({ message: turnMessage, assistantText }) => [
          { role: 'user', content: turnMessage },
          { role: 'assistant', content: assistantText },
        ]),
        {
          role: 'user',
          content: JSON.stringify({ formValues, fields, message }),
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'form_update',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['reply', 'changes'],
            properties: {
              reply: { type: 'string' },
              changes: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['field', 'valueJson', 'reason'],
                  properties: {
                    field: { type: 'string' },
                    valueJson: { type: 'string' },
                    reason: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      'OpenAI request failed. Check the configured API key and try again.',
    );
  }

  const data = await response.json();
  const text = getResponseText(data);

  if (!text) throw new Error('OpenAI returned an empty response.');

  try {
    const result = JSON.parse(text);
    return {
      ...result,
      changes: result.changes.map(({ valueJson, ...change }) => ({
        ...change,
        value: JSON.parse(valueJson),
      })),
      assistantText: text,
    };
  } catch {
    throw new Error(
      'OpenAI returned an invalid response. No form changes were made.',
    );
  }
};
