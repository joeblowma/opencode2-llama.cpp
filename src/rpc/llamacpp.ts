import {Rpc} from '@opencode/plugin'

/**
 * Wire contract between the server plugin and the TUI plugin.
 *
 * These run in **different processes**. The server owns discovery and the model
 * catalog; the TUI owns toasts. Neither can reach the other directly, so this
 * definition is the bridge: the server emits `notified` when a manual command
 * finishes, and the TUI turns that into a toast.
 *
 * Schemas are plain JSON Schema rather than zod so the TUI half stays
 * dependency-free — a TUI plugin is loaded into the render loop, and every
 * import it carries is on that hot path.
 */
export const LLAMACPP_RPC_ID = 'opencode-llama-cpp'

const EmptyInput = {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
} as const

/** Result of a refresh, flattened for the wire. */
const RefreshResult = {
    type: 'object',
    properties: {
        text: {type: 'string'},
        variant: {type: 'string', enum: ['info', 'warning', 'error']},
    },
    required: ['text', 'variant'],
    additionalProperties: false,
} as const

/** Result of an unload request. */
const UnloadInput = {
    type: 'object',
    properties: {
        model: {type: 'string'},
    },
    required: ['model'],
    additionalProperties: false,
} as const

export const LlamaCppRpc = Rpc.define({
    id: LLAMACPP_RPC_ID,
    methods: {
        /** Re-scan the server and reload the catalog if anything changed. */
        refresh: {
            input: EmptyInput,
            output: RefreshResult,
        },
        /** Evict a resident model to free VRAM. */
        unload: {
            input: UnloadInput,
            output: RefreshResult,
        },
    },
    events: {
        /**
         * A manual command finished. Carries ready-to-display text so the TUI
         * never has to re-derive or re-format the server's wording.
         */
        notified: {
            schema: {
                type: 'object',
                properties: {
                    text: {type: 'string'},
                    variant: {type: 'string', enum: ['info', 'warning', 'error']},
                },
                required: ['text', 'variant'],
                additionalProperties: false,
            },
        },
    },
})

export type LlamaCppRpcVariant = 'info' | 'warning' | 'error'
export type LlamaCppRpcResult = {text: string; variant: LlamaCppRpcVariant}