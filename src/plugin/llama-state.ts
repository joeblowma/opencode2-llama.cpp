import type {LlamaCppModel} from '../types'

/**
 * Shared, mutable snapshot of the llama.cpp server this plugin is bound to.
 *
 * V2 transforms are replayable state edits: the callback registered with
 * `ctx.provider.transform` is re-invoked by OpenCode whenever the catalog is
 * rebuilt. It must therefore stay synchronous and read only from this snapshot,
 * rather than re-fetching or re-registering work of its own.
 *
 * Both the provider transform and the session validation hook read from here so
 * they cannot disagree about which server is in play.
 */
export interface LlamaState {
    /** Normalized base URL, without a trailing `/v1`. */
    baseURL: string | null
    /**
     * Last successfully discovered models. Retained when the server goes offline
     * so a transient outage does not strip the catalog back to nothing.
     */
    models: LlamaCppModel[]
}

const state: LlamaState = {
    baseURL: null,
    models: [],
}

export function getLlamaState(): Readonly<LlamaState> {
    return state
}

export function setLlamaBaseURL(baseURL: string): void {
    state.baseURL = baseURL
}

export function setLlamaModels(models: LlamaCppModel[]): void {
    state.models = models
}

export function getLlamaBaseURL(): string | null {
    return state.baseURL
}

/**
 * The last observed load state for a model (`"loaded"`, `"loading"`,
 * `"unloaded"`), or `undefined` if we have never seen it.
 *
 * Sourced from `/models`, which reports this without loading anything — unlike
 * `/props`, whose mere request triggers an autoload under `models_autoload`.
 */
export function getModelStatus(modelID: string): string | undefined {
    return state.models.find((model) => model.id === modelID)?.status?.value
}