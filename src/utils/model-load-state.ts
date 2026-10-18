import type {LlamaCppModel} from '../types'

/**
 * The load state of a model on a `llama-server` in router mode.
 *
 * `llama-server` documents four states for a routed model. Only `loaded` means
 * the weights are resident; everything else carries a latency cost, and the
 * magnitude differs sharply between them.
 */
export type ModelLoadState = 'loaded' | 'loading' | 'unloaded' | 'unreachable'

/** Parse the server's free-form `status.value` into a known state. */
export function parseLoadState(value: string | undefined): ModelLoadState {
    switch (value?.trim().toLowerCase()) {
        case 'loaded':
            return 'loaded'
        case 'loading':
            return 'loading'
        // Unknown/absent is treated as cold rather than assumed ready: assuming
        // ready is what produces a silent multi-minute stall.
        default:
            return 'unloaded'
    }
}

/** Whether the model's weights are resident and it can serve immediately. */
export function isReady(model: LlamaCppModel): boolean {
    return parseLoadState(model.status?.value) === 'loaded'
}

/**
 * A short, actionable note for when a model is not resident.
 *
 * Intended for a system-prompt warning, so it states what is happening and what
 * the user can do, without padding. `loading` is distinguished from `unloaded`
 * because the remedy differs: one is already in progress, the other is not
 * started at all.
 */
export function describeColdModel(model: LlamaCppModel): string {
    const state = parseLoadState(model.status?.value)

    if (state === 'loading') {
        return `[llama.cpp] Model '${model.id}' is currently loading on the server. `
            + 'This first request will wait until the weights are resident — expect a pause.'
    }

    return `[llama.cpp] Model '${model.id}' is not loaded on the llama.cpp server. `
        + 'The request will trigger a model load first, which can take a while on a large model. '
        + 'Pick an already-loaded model for a fast first response.'
}