import {Plugin} from "@opencode/plugin"
import {createConfigHook} from './config-hook'
import {createChatParamsHook} from './chat-params-hook'
import {createEventHook} from './event-hook'
import {createRefreshCommand} from './refresh-command'
import {createUnloadCommand} from './unload-command'
import {createRpcBridge} from './rpc-bridge'
import {log} from '../utils/log'

/**
 * llama.cpp Plugin - V2 Version
 *
 * Features:
 * - Auto-detection of running llama.cpp instance
 * - Dynamic model discovery from llama.cpp API
 * - Real-time model validation with smart error handling
 * - Comprehensive caching system with API call reduction
 *
 * This is the *server* half. A companion TUI plugin (`src/tui.ts`) shows toasts
 * for the commands below; the two are joined by the RPC bridge, since they run
 * in different processes.
 */
export const LlamaCppPlugin = Plugin.define({
    id: "llama-cpp",
    async setup(ctx) {
        log.info("llama.cpp plugin initialized")

        // Register catalog transform for auto-detection and model discovery
        const configCleanup = await createConfigHook(ctx)

        // Register session hook for model validation
        const chatCleanup = await createChatParamsHook(ctx)

        // Register event subscription
        const eventCleanup = createEventHook(ctx)

        // Bridge to the TUI process. Created before the commands so they can
        // report through it; a failure here only costs toasts, not the plugin.
        const bridge = await createRpcBridge(ctx).catch((error) => {
            log.warn('RPC bridge unavailable; command results will be log-only', {error: String(error)})
            return undefined
        })

        // Manual escape hatch from the 60s sweep, for when a minute is too long
        const commandCleanup = await createRefreshCommand(ctx, bridge)

        // Free VRAM by evicting a resident model
        const unloadCleanup = await createUnloadCommand(ctx, bridge)

        // Return cleanup function
        return async () => {
            if (configCleanup) await configCleanup()
            if (chatCleanup) await chatCleanup()
            if (commandCleanup) await commandCleanup()
            if (unloadCleanup) await unloadCleanup()
            await bridge?.dispose()
            if (eventCleanup) eventCleanup()
        }
    },
})