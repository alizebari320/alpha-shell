// Provider abstraction layer.
//
// Every AI provider (xAI, OpenAI, local LLM, etc.) implements AIProvider.
// The rest of the system talks to the provider through this interface only,
// so adding a new provider never requires changes to the UI or the AIService.

export class AIProvider {
    constructor(config = {}) {
        this.config = config;
    }

    // Short identifier, must match a key in models.js PROVIDERS.
    get id() {
        return 'base';
    }

    get displayName() {
        return 'Base Provider';
    }

    // Whether this provider needs an API key / auth material.
    get requiresAuth() {
        return true;
    }

    // Load credentials from the system secret store (GNOME libsecret),
    // never from source code or environment files committed to git.
    async authenticate(_settings) {
        throw new Error(`authenticate() not implemented for ${this.displayName}`);
    }

    // Every request ends up here as a list of { role, content } messages.
    async chat(_messages, _options = {}) {
        throw new Error(`chat() not implemented for ${this.displayName}`);
    }
}

const _registry = new Map();

export function registerProvider(provider) {
    _registry.set(provider.id, provider);
    return provider;
}

export function getProvider(id) {
    return _registry.get(id) || null;
}