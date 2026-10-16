import type {Plugin} from '@opencode/plugin'
import {fetchModelProps} from '../utils/llama-cpp-api'
import {getModelStatus} from './llama-state'
import {log} from '../utils/log'

const PROVIDER_ID = 'llama.cpp'

/**
 * Tool support per model id, learned once and remembered for the plugin's life.
 *
 * This is a *static* property of a model's chat template, so a negative result is
 * as final as a positive one and neither needs re-checking.
 */
const cache = new Map<string, boolean>()

/** Models with a probe currently in flight, so we never stack duplicate loads. */
const inFlight = new Set<string>()

export function getCachedToolSupport(modelID: string): boolean | undefined {
    return cache.get(modelID)
}

/** Test seam. */
export function resetToolSupportCache(): void {
    cache.clear()
    inFlight.clear()
}

/**
 * Learn whether a model supports tool calling, and promote the catalog if so.
 *
 * llama.cpp exposes no static capability field — function calling depends on the
 * chat template plus `--jinja`. `chat_template_caps` in `/props` is that
 * dependency already resolved.
 *
 * Three deliberate constraints:
 *
 * - **Only probe a model that is already loaded.** `/models` reports load state
 *   for free, and in router mode *merely requesting* `/props?model=` autoloads
 *   the model. Aborting the client fetch does **not** cancel that server-side
 *   load, so a timeout is not a safe way to avoid it. Gating on `status.value`
 *   is the only reliable guard, and it means the plugin never causes a load it
 *   did not need — the model is loaded because the user is already using it.
 * - **Fire and forget.** Even when warm the probe must not delay a request, so
 *   it runs detached behind a short timeout and the result lands on a later turn.
 * - **Promote only.** A confirmed `true` is applied to the catalog; a `false` is
 *   left alone. We never override a value the user set deliberately in config.
 *
 * Only the model actually being used is ever probed — the discovery sweep does
 * not touch this — so there is no fan-out across the catalog and no VRAM thrash.
 */
export function detectToolSupport(
    ctx: Plugin.Context,
    baseURL: string,
    modelID: string,
): void {
    if (cache.has(modelID) || inFlight.has(modelID)) return

    // Guard before the request, not after: an aborted fetch still autoloads.
    if (getModelStatus(modelID) !== 'loaded') {
        log.debug('Skipping tool probe; model not loaded yet', {model: modelID})
        return
    }

    inFlight.add(modelID)

    void (async () => {
        try {
            const props = await fetchModelProps(baseURL, modelID)
            const caps = props?.chat_template_caps
            if (!caps) {
                // Timed out or endpoint unavailable. Leave it unknown so a later
                // request can try again.
                log.debug('Tool support probe inconclusive', {model: modelID})
                return
            }

            const supports = caps.supports_tools === true || caps.supports_tool_calls === true
            cache.set(modelID, supports)
            log.debug('Tool support resolved', {model: modelID, supports})

            if (supports) {
                await promoteToolSupport(ctx, modelID)
            }
        } catch (error) {
            log.debug('Tool support probe failed', {model: modelID, error: String(error)})
        } finally {
            inFlight.delete(modelID)
        }
    })()
}

/** Flip `capabilities.tools` on for one already-registered model. */
async function promoteToolSupport(ctx: Plugin.Context, modelID: string): Promise<void> {
    try {
        let changed = false

        await ctx.model.transform((editor) => {
            const existing = editor.get(PROVIDER_ID, modelID)
            if (!existing) return
            if (existing.capabilities.tools === true) return
            editor.update(PROVIDER_ID, modelID, (model) => {
                model.capabilities.tools = true
            })
            changed = true
        })

        if (changed) {
            await ctx.model.reload()
            log.info(`Enabled tool calling for ${modelID} (chat template supports it)`)
        }
    } catch (error) {
        log.warn('Failed to promote tool support', {model: modelID, error: String(error)})
    }
}