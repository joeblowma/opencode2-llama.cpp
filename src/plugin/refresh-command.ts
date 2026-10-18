import type {Plugin} from '@opencode/plugin'
import {refreshNow, type RefreshOutcome} from './config-hook'
import {report} from './notify'
import {log} from '../utils/log'

const COMMAND_NAME = 'llamacpp-refresh'
const COMMAND_DESCRIPTION = 'Re-scan the llama.cpp server now instead of waiting for the 60s timer'

/**
 * Turn a refresh outcome into one line a user can act on.
 *
 * Kept separate from the command wiring so the wording is unit-testable and
 * the command handler stays trivial.
 */
export function describeRefresh(result: RefreshOutcome): string {
    switch (result.outcome) {
        case 'changed':
            return `llama.cpp: catalog updated — ${result.count} model(s) from ${result.baseURL}`
        case 'unchanged':
            return `llama.cpp: no change — ${result.count} model(s) at ${result.baseURL}`
        case 'unreachable':
            return `llama.cpp: server not answering at ${result.baseURL}. It may have stopped; models from the last successful scan are still listed.`
        case 'no-server':
            return 'llama.cpp: no server found. Start one, then run this again.'
    }
}

/**
 * Register the manual refresh command.
 *
 * Why a command rather than an event hook: `/models` only re-selects within the
 * existing catalog, and none of the TUI events fire on it. The data being
 * watched lives in another process that offers no change notification, so the
 * 60s sweep is the automatic safety net — this is the escape hatch when a minute
 * is too long to wait after changing a `llama-server` preset.
 */
export async function createRefreshCommand(ctx: Plugin.Context): Promise<(() => Promise<void>) | void> {
    try {
        const registration = await ctx.command.transform((editor) => {
            editor.add({
                name: COMMAND_NAME,
                description: COMMAND_DESCRIPTION,
                execute: async () => {
                    const result = await refreshNow(ctx)
                    const message = describeRefresh(result)

                    // info for the expected no-change case, warn for problems:
                    // "nothing happened" is a normal result here, not a fault.
                    const level = result.outcome === 'changed' || result.outcome === 'unchanged'
                        ? 'info'
                        : 'warn'

                    await report(message, level)
                },
            })
        })

        return async () => {
            await registration.dispose()
        }
    } catch (error) {
        // A missing command domain must not take the whole plugin down.
        log.warn('Failed to register refresh command', {error: String(error)})
    }
}