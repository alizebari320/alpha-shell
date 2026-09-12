// Model catalog. Provider ids, model ids and capabilities below are PLACEHOLDERS
// supplied by the user as examples. None of these endpoints, api names or auth
// methods are real until a concrete provider is chosen in a later phase.
//
// IMPORTANT: this file contains NO api keys, secrets, or endpoints.

export const PROVIDERS = {
    xai: {
        id: 'xai',
        displayName: 'xAI',
        description: 'Provider for Grok series models',
        models: ['grok-4.6'],
    },
    openai: {
        id: 'openai',
        displayName: 'OpenAI',
        description: 'Provider for GPT series models',
        models: ['gpt-6-astra', 'gpt-5.5', 'gpt-5.6'],
    },
};

// A model is: { id, provider, capabilities }
// capabilities inform the UI which operations make sense for a given model.
export const MODELS = [
    {
        id: 'grok-4.6',
        provider: 'xai',
        capabilities: ['chat', 'summarize', 'code', 'command', 'vision', 'search'],
    },
    {
        id: 'gpt-6-astra',
        provider: 'openai',
        capabilities: ['chat', 'summarize', 'code', 'command', 'vision', 'search'],
    },
    {
        id: 'gpt-5.5',
        provider: 'openai',
        capabilities: ['chat', 'summarize', 'code', 'command', 'vision', 'search'],
    },
    {
        id: 'gpt-5.6',
        provider: 'openai',
        capabilities: ['chat', 'summarize', 'code', 'command', 'vision', 'search'],
    },
];

export function getModelById(modelId) {
    return MODELS.find((m) => m.id === modelId) || null;
}

export function getModelsForProvider(providerId) {
    return MODELS.filter((m) => m.provider === providerId);
}