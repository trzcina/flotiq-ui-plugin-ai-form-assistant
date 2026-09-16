export const registerPluginSettings = (handler) => {
  handler.on('flotiq.plugins.manage::form-schema', () => ({
    schema: {
      id: 'flotiq.ai-form-assistant-settings',
      schemaDefinition: {
        type: 'object',
        allOf: [
          {
            $ref: '#/components/schemas/AbstractContentTypeSchemaDefinition',
          },
          {
            type: 'object',
            properties: {
              openAiApiKey: {
                type: 'string',
                minLength: 1,
              },
              defaultPrompts: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['title', 'prompt'],
                  properties: {
                    title: {
                      type: 'string',
                      minLength: 1,
                    },
                    prompt: {
                      type: 'string',
                      minLength: 1,
                    },
                  },
                },
              },
            },
          },
        ],
        required: ['openAiApiKey'],
        additionalProperties: false,
      },
      metaDefinition: {
        order: ['openAiApiKey', 'defaultPrompts'],
        propertiesConfig: {
          openAiApiKey: {
            label: 'OpenAI API key',
            unique: false,
            helpText:
              'The key is used from your browser when you send a message.',
            inputType: 'text',
            isPassword: true,
          },
          defaultPrompts: {
            label: 'Default prompts',
            unique: false,
            helpText: 'These appear as shortcuts in the assistant.',
            inputType: 'object',
            items: {
              order: ['title', 'prompt'],
              propertiesConfig: {
                title: {
                  label: 'Title',
                  unique: false,
                  inputType: 'text',
                },
                prompt: {
                  label: 'Prompt',
                  unique: false,
                  inputType: 'text',
                },
              },
            },
          },
        },
      },
    },
  }));
};
