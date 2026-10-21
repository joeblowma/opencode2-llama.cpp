import {define} from '@opencode/plugin/tui/plugin'
import {LlamaCppRpc, type LlamaCppRpcResult} from './rpc/llamacpp'

/**
 * TUI half of the plugin: turns server notifications into toasts.
 *
 * This runs in the TUI process, which is why it is a separate plugin at all. A
 * server plugin has no `ui` domain, and its command output has no channel to
 * the interface — the only supported way to show a user something from the
 * server is to have a TUI plugin listening for it.
 *
 * Deliberately no Solid JSX: `ctx.ui.toast` is a plain method call, so pulling
 * in a reactive runtime would cost start-up time for no benefit. That is also
 * why this imports `@opencode/plugin/tui/plugin` rather than the
 * `@opencode/plugin/tui` barrel — the barrel re-exports `solid.js`, which would
 * drag `solid-js` into the load path for no benefit.
 */

/** Map the RPC variant onto the TUI's toast variants. */
function toToastVariant(variant: string): 'info' | 'success' | 'warning' | 'error' {
    switch (variant) {
        case 'warning':
            return 'warning'
        case 'error':
            return 'error'
        default:
            return 'info'
    }
}

/** Short title so the toast is attributable without reading the message. */
const TITLE = 'llama.cpp'

export default define({
    id: 'opencode-llama-cpp-tui',
    setup(ctx) {
        const client = ctx.client.rpc(LlamaCppRpc)

        const unsubscribe = client.events.on('notified', (event) => {
            const data = event?.data as LlamaCppRpcResult | undefined
            if (!data?.text) return

            ctx.ui.toast.show({
                title: TITLE,
                message: data.text,
                variant: toToastVariant(data.variant),
                // Long enough to read a model name, short enough not to stack up
                // if several refreshes land in a row.
                duration: 5000,
            })
        })

        return async () => {
            unsubscribe()
        }
    },
})