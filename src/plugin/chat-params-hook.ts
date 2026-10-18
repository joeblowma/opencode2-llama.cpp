import type {Plugin} from '@opencode/plugin'
import {getLoadedModels} from './get-loaded-models'
import {getLlamaBaseURL, getLlamaState, setActiveModel} from './llama-state'
import {detectToolSupport} from './tool-support'
import {categorizeError, retryWithBackoff} from '../utils'
import {describeColdModel, isReady} from '../utils/model-load-state'
import {log} from '../utils/log'

const PROVIDER_ID = 'llama.cpp'
const FALLBACK_BASE_URL = 'http://127.0.0.1:1234'

export async function createChatParamsHook(ctx: Plugin.Context): Promise<(() => Promise<void>) | void> {
    // Registered for the agent loop only. Compaction/title/generate are separate
    // hooks and do not need model-load validation.
    const registration = await ctx.session.hook('context', async (event) => {
        const modelID = event.model?.id
        const providerID = event.model?.providerID

        if (providerID !== PROVIDER_ID || !modelID) {
            return
        }

        try {
            // Recorded so `/llamacpp-unload` can protect the in-flight model.
            setActiveModel(modelID)

            const baseURL = getLlamaBaseURL() ?? FALLBACK_BASE_URL

            // Learn tool support for the model actually in use. Detached and
            // cached, so it never delays this request and only ever probes one
            // model at a time.
            detectToolSupport(ctx, baseURL, modelID)

            const validationResult = await retryWithBackoff(
                async () => {
                    const loadedModels = await getLoadedModels(baseURL)
                    if (!loadedModels.includes(modelID)) {
                        throw new Error(`Model '${modelID}' not loaded`)
                    }
                    return loadedModels
                },
                2, // Max 2 retries
                500, // 500ms base delay
            )

            if (!validationResult.success) {
                // Prefer the specific cold-model explanation over a generic
                // network-style error: "not loaded" and "unreachable" call for
                // different user actions, and conflating them sends people
                // chasing a server that is in fact perfectly healthy.
                const known = getLlamaState().models.find((m) => m.id === modelID)

                if (known && !isReady(known)) {
                    const message = describeColdModel(known)

                    log.info('Model not resident', {model: modelID, baseURL})

                    event.system.push({type: 'text', text: message})
                } else {
                    const errorCategory = categorizeError(validationResult.error || 'Validation failed', {
                        baseURL,
                        modelId: modelID,
                    })

                    log.warn('Model validation failed', {
                        model: modelID,
                        error: validationResult.error,
                        errorType: errorCategory.type,
                        severity: errorCategory.severity,
                        baseURL,
                    })

                    // Warn rather than block: llama.cpp may be mid-load.
                    event.system.push({
                        type: 'text',
                        text: `[llama.cpp warning] Model '${modelID}' is not currently loaded on the llama.cpp server at ${baseURL}. ` +
                            `The request may fail. Error: ${errorCategory.message}`,
                    })
                }
            } else {
                log.debug(`Model '${modelID}' validated successfully`)
            }
        } catch (error) {
            log.error('Model validation error', {error: String(error)})
        }
    })

    return async () => {
        await registration.dispose()
    }
}