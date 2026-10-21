import type {Plugin} from '@opencode/plugin'
import {LlamaCppRpc, type LlamaCppRpcResult, type LlamaCppRpcVariant} from '../rpc/llamacpp'
import {refreshNow} from './config-hook'
import {performUnload} from './unload-command'
import {describeRefresh} from './refresh-command'
import {describeUnload} from './unload-command'
import {log} from '../utils/log'

/** Map a refresh outcome onto a toast variant. */
export function refreshVariant(outcome: string): LlamaCppRpcVariant {
    return outcome === 'changed' || outcome === 'unchanged' ? 'info' : 'warning'
}

/** Map an unload outcome onto a toast variant. */
export function unloadVariant(kind: string): LlamaCppRpcVariant {
    return kind === 'unloaded' || kind === 'listed' || kind === 'not-loaded' ? 'info' : 'warning'
}

export interface RpcBridge {
    /** Run a refresh and return the user-facing result. */
    refresh: () => Promise<LlamaCppRpcResult>
    /** Unload a model (empty string lists) and return the user-facing result. */
    unload: (model: string) => Promise<LlamaCppRpcResult>
    /** Push a result to any connected TUI. Never throws. */
    notify: (result: LlamaCppRpcResult) => Promise<void>
    dispose: () => Promise<void>
}

/**
 * Wire the RPC surface and share the same implementations with the commands.
 *
 * The command handlers and the RPC methods deliberately call the *same*
 * functions, so a refresh triggered either way produces identical behaviour and
 * identical wording. Emitting to the TUI is fire-and-forget: a toast is a
 * courtesy, and a failure to deliver must not fail the user's command.
 */
export async function createRpcBridge(ctx: Plugin.Context): Promise<RpcBridge> {
    const refresh = async (): Promise<LlamaCppRpcResult> => {
        const outcome = await refreshNow(ctx)
        return {text: describeRefresh(outcome), variant: refreshVariant(outcome.outcome)}
    }

    const unload = async (model: string): Promise<LlamaCppRpcResult> => {
        const outcome = await performUnload(model.trim() === '' ? undefined : model)
        return {text: describeUnload(outcome), variant: unloadVariant(outcome.kind)}
    }

    // Populated after registration; the commands use it to reach the TUI.
    let emit: ((result: LlamaCppRpcResult) => Promise<void>) | null = null

    const notify = async (result: LlamaCppRpcResult): Promise<void> => {
        if (!emit) return
        try {
            await emit(result)
        } catch (error) {
            log.debug('Could not notify TUI', {error: String(error)})
        }
    }

    const registration = await ctx.rpc.register(LlamaCppRpc, {
        refresh: async () => refresh(),
        // JSON Schema does not carry a TypeScript type, so the input is widened
        // to `unknown` here and narrowed once, at the boundary.
        unload: async (input: unknown) => {
            const model = typeof (input as {model?: unknown})?.model === 'string'
                ? (input as {model: string}).model
                : ''
            return unload(model)
        },
    })

    emit = async (result) => {
        await registration.events.emit('notified', result)
    }

    return {
        refresh,
        unload,
        notify,
        dispose: async () => {
            emit = null
            await registration.dispose()
        },
    }
}