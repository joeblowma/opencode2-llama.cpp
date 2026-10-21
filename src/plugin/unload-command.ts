import type {Plugin} from '@opencode/plugin'
import {getActiveModel, getLlamaBaseURL, getLlamaState} from './llama-state'
import {isReady} from '../utils/model-load-state'
import {unloadLlamaCppModel} from '../utils/llama-cpp-api'
import {report} from './notify'
import type {RpcBridge} from './rpc-bridge'
import {log} from '../utils/log'

const COMMAND_NAME = 'llamacpp-unload'
const COMMAND_DESCRIPTION =
    'Unload a model from llama.cpp to free VRAM. With no argument, lists what is loaded.'

/**
 * Parse the model id out of a command invocation.
 *
 * The invocation carries the whole prompt line (`/llamacpp-unload <id>`), and
 * the command name may or may not be included depending on how the host
 * strips it, so both forms are accepted. Returns undefined for a bare command.
 */
export function parseUnloadTarget(promptText: string | undefined): string | undefined {
    if (!promptText) return undefined

    const tokens = promptText.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return undefined

    // Drop the command name if it survived into the prompt text.
    const rest = tokens[0].replace(/^\/+/, '').toLowerCase() === COMMAND_NAME ? tokens.slice(1) : tokens

    return rest.length > 0 ? rest.join(' ') : undefined
}

/** Resolve which model the user meant, tolerating a unique prefix. */
export function resolveTarget(
    requested: string,
    models: readonly {id: string}[],
): {found: true; id: string} | {found: false; reason: 'unknown' | 'ambiguous'; candidates: string[]} {
    const exact = models.find((m) => m.id === requested)
    if (exact) return {found: true, id: exact.id}

    const lowered = requested.toLowerCase()
    const insensitive = models.find((m) => m.id.toLowerCase() === lowered)
    if (insensitive) return {found: true, id: insensitive.id}

    const partial = models.filter((m) => m.id.toLowerCase().includes(lowered))
    if (partial.length === 1) return {found: true, id: partial[0].id}
    if (partial.length > 1) return {found: false, reason: 'ambiguous', candidates: partial.map((m) => m.id)}

    return {found: false, reason: 'unknown', candidates: []}
}

export type UnloadOutcome =
    | {kind: 'listed'; loaded: string[]}
    | {kind: 'unloaded'; model: string}
    | {kind: 'refused-active'; model: string}
    | {kind: 'not-loaded'; model: string}
    | {kind: 'unknown-model'; requested: string}
    | {kind: 'ambiguous'; requested: string; candidates: string[]}
    | {kind: 'failed'; model: string; error: string}
    | {kind: 'no-server'}

/** Perform the unload, returning a specific outcome rather than a bare boolean. */
export async function performUnload(requested: string | undefined): Promise<UnloadOutcome> {
    const baseURL = getLlamaBaseURL()
    if (!baseURL) return {kind: 'no-server'}

    const {models} = getLlamaState()

    if (requested === undefined) {
        return {kind: 'listed', loaded: models.filter(isReady).map((m) => m.id)}
    }

    const target = resolveTarget(requested, models)
    if (!target.found) {
        return target.reason === 'ambiguous'
            ? {kind: 'ambiguous', requested, candidates: target.candidates}
            : {kind: 'unknown-model', requested}
    }

    // Unloading the model mid-request strands the request with no useful error,
    // and there is no way to ask the server whether a slot is busy.
    if (target.id === getActiveModel()) {
        return {kind: 'refused-active', model: target.id}
    }

    // Already cold: the goal is met, so do not spend a round trip.
    if (!isReady(models.find((m) => m.id === target.id)!)) {
        return {kind: 'not-loaded', model: target.id}
    }

    const result = await unloadLlamaCppModel(baseURL, target.id)
    if (!result.success) return {kind: 'failed', model: target.id, error: result.error}

    return {kind: 'unloaded', model: target.id}
}

/**
 * Turn an unload outcome into one line a user can act on.
 *
 * No `llama.cpp:` prefix: the logger adds `[opencode-llama-cpp]` and the toast
 * carries a `llama.cpp` title, so a prefix here would be shown twice.
 */
export function describeUnload(outcome: UnloadOutcome): string {
    switch (outcome.kind) {
        case 'listed':
            return outcome.loaded.length === 0
                ? 'Nothing is currently loaded.'
                : `Loaded now — ${outcome.loaded.join(', ')}`
        case 'unloaded':
            return `Unloaded ${outcome.model} (VRAM freed)`
        case 'refused-active':
            return `Refusing to unload ${outcome.model} — it is the model carrying your current request. Switch models first, then unload it.`
        case 'not-loaded':
            return `${outcome.model} was already unloaded.`
        case 'unknown-model':
            return `No model matches "${outcome.requested}". Run /llamacpp-unload on its own to list loaded models.`
        case 'ambiguous':
            return `"${outcome.requested}" matches ${outcome.candidates.length} models — use more of the name: ${outcome.candidates.slice(0, 5).join(', ')}`
        case 'failed':
            return `Could not unload ${outcome.model} — ${outcome.error}`
        case 'no-server':
            return 'No server found.'
    }
}

/**
 * Register the VRAM-freeing unload command.
 *
 * Unloading is the escape hatch for a router whose slots are stuck holding a
 * model: weights stay resident until something evicts them, so a stale load can
 * hold gigabytes with no error anywhere.
 */
export async function createUnloadCommand(
    ctx: Plugin.Context,
    bridge?: RpcBridge,
): Promise<(() => Promise<void>) | void> {
    try {
        const registration = await ctx.command.transform((editor) => {
            editor.add({
                name: COMMAND_NAME,
                description: COMMAND_DESCRIPTION,
                execute: async (input) => {
                    const target = parseUnloadTarget(input?.prompt?.text)

                    // Through the bridge when available, so the command and the
                    // RPC method share one implementation and the TUI is told.
                    const result = bridge
                        ? await bridge.unload(target ?? '')
                        : {text: describeUnload(await performUnload(target)), variant: 'info' as const}

                    await report(result.text, result.variant === 'info' ? 'info' : 'warn')
                    await bridge?.notify(result)
                },
            })
        })

        return async () => {
            await registration.dispose()
        }
    } catch (error) {
        log.warn('Failed to register unload command', {error: String(error)})
    }
}