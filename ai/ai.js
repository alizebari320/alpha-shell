// AIService — the single facade the UI talks to.
//
// It owns provider/model selection (read from GSettings) and exposes one method
// per user-facing operation. Every operation is an async stub right now: it
// returns a rejected promise with a clear message until a provider is chosen
// and wired in. This keeps the overlay fully functional as a skeleton without
// ever making a network call or exposing credentials.

import { PROVIDERS, getModelById, getModelsForProvider } from './models.js';
import { getProvider } from './providers.js';
import { CommandApprover } from './safety.js';

const NOT_IMPLEMENTED = 'AI integration is not implemented yet. No provider has been selected.';

export class AIService {
    constructor(settings) {
        this._settings = settings; // Gio.Settings instance (may be null in tests)
        this._providerId = settings ? settings.get_string('provider') : '';
        this._modelId = settings ? settings.get_string('model') : '';
        this.approver = new CommandApprover();
    }

    listProviders() {
        return Object.values(PROVIDERS);
    }

    listModels() {
        return getModelsForProvider(this._providerId);
    }

    get providerId() {
        return this._providerId;
    }

    set providerId(id) {
        this._providerId = id;
        if (this._settings) this._settings.set_string('provider', id);
    }

    get modelId() {
        return this._modelId;
    }

    set modelId(id) {
        this._modelId = id;
        if (this._settings) this._settings.set_string('model', id);
    }

    get model() {
        return getModelById(this._modelId);
    }

    // --- Operations -------------------------------------------------------

    // "Ask AI" typed in the overlay.
    ask(prompt) {
        return this._stub('ask', prompt);
    }

    // Selected text sent to the AI.
    sendSelectedText(text, action = 'explain') {
        return this._stub('sendSelectedText', text, action);
    }

    summarize(text) {
        return this._stub('summarize', text);
    }

    explainCode(code) {
        return this._stub('explainCode', code);
    }

    // Returns a proposed command (via CommandApprover), never executes it.
    generateCommand(intent) {
        const result = this._stub('generateCommand', intent);
        return result; // UI receives the proposal from approver for display
    }

    analyzeScreenshot(imagePath) {
        return this._stub('analyzeScreenshot', imagePath);
    }

    search(query) {
        return this._stub('search', query);
    }

    // Every unimplemented operation funnels through here.
    _stub(operation, ..._args) {
        const provider = getProvider(this._providerId);
        if (!provider) {
            return Promise.reject(new Error(NOT_IMPLEMENTED));
        }
        return Promise.reject(
            new Error(`'${operation}' not implemented for provider '${this._providerId}'`)
        );
    }
}