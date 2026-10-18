import type {LlamaCppModel} from '../types'
import {FALLBACK_CONTEXT_SIZE} from '../utils/resolve-context-size'
import {log} from '../utils/log'

/**
 * Floor for a user-supplied `fallbackContext`. Below this the value stops being
 * a conservative guess and starts breaking working conversations.
 */
const MIN_FALLBACK_CONTEXT = 4_096

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
    /**
     * Context to advertise when a model reports none. Lives here rather than in
     * a closure because the catalog transform is replayed by OpenCode and must
     * not capture per-setup values from its registration call.
     */
    fallbackContext: number
}

const state: LlamaState = {
    baseURL: null,
    models: [],
    fallbackContext: FALLBACK_CONTEXT_SIZE,
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

/**
 * Set the context advertised for models that report none.
 *
 * Clamped to a sane floor: a value low enough to truncate every conversation is
 * a worse failure than over-reporting, and a typo like `0` would otherwise make
 * the model unusable rather than merely conservative.
 */
export function setFallbackContext(context: number): void {
    if (!Number.isFinite(context) || context < MIN_FALLBACK_CONTEXT) {
        log.warn('Ignoring out-of-range fallbackContext', {
            requested: context,
            minimum: MIN_FALLBACK_CONTEXT,
        })
        state.fallbackContext = FALLBACK_CONTEXT_SIZE
        return
    }
    state.fallbackContext = Math.floor(context)
}

export function getFallbackContext(): number {
    return state.fallbackContext
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