import {Model, Provider} from '@opencode/plugin'
import type {Plugin} from '@opencode/plugin'
import {existsSync, readFileSync} from 'fs'
import {join} from 'path'
import {modelStatusCache} from '../cache'
import {categorizeModel, formatModelName, parseJsonc, resolveContextSize} from '../utils'
import {autoDetectLlamaCpp, checkLlamaCppHealth, DEFAULT_LLAMA_CPP_PORTS, discoverLlamaCppModels, normalizeBaseURL} from '../utils/llama-cpp-api'
import {findUnloadableModels} from '../utils/unloadable-models'
import type {LlamaCppModel} from '../types'
import {log} from '../utils/log'
import {getFallbackContext, getLlamaBaseURL, getLlamaState, setFallbackContext, setLlamaBaseURL, setLlamaModels} from './llama-state'

/** Provider ID this plugin owns. */
const PROVIDER_ID = 'llama.cpp'
const PROVIDER_NAME = 'llama.cpp (local)'
/** Driver package OpenCode loads for an OpenAI-compatible endpoint. */
const PROVIDER_PACKAGE = '@opencode/ai/providers/openai-compatible'
const REFRESH_INTERVAL_MS = 60_000

/**
 * Ids of models hidden on the previous sweep.
 *
 * Tracked so a broken preset is warned about once, on the change, rather than
 * on every 60s tick for as long as the condition holds.
 */
let lastHiddenSignature = ''

/** The callback type `ctx.provider.transform` expects. */
type ProviderTransform = Parameters<Plugin.Context['provider']['transform']>[0]

const providerID = PROVIDER_ID as Provider.ID

/**
 * Result of a manual refresh, shaped so the slash command can report something
 * specific rather than a bare success/failure.
 */
export type RefreshOutcome =
    | {outcome: 'changed'; baseURL: string; count: number}
    | {outcome: 'unchanged'; baseURL: string; count: number}
    | {outcome: 'unreachable'; baseURL: string}
    | {outcome: 'no-server'}

/**
 * `Model.ID.make` exists at runtime but is not surfaced on the inferred
 * `Schema.brand` type, so the branded cast lives here rather than at each use.
 */
const modelID = (id: string) => id as Model.ID

/**
 * Read a baseURL from opencode config files.
 *
 * A fallback only — `ctx.provider.list()` is the supported source of truth and is
 * tried first. Config files are still consulted because a provider may be
 * declared without having been loaded at plugin-setup time.
 */
function readBaseURLFromConfig(): string | null {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const cwd = process.cwd()

    const configPaths = [
        join(home, '.config/opencode/opencode.json'),
        join(home, '.config/opencode/opencode.jsonc'),
        join(cwd, 'opencode.json'),
        join(cwd, 'opencode.jsonc'),
        join(cwd, '.opencode/opencode.json'),
        join(cwd, '.opencode/opencode.jsonc'),
    ]

    log.debug(`Searching config in: HOME=${home}, CWD=${cwd}`)

    for (const configPath of configPaths) {
        if (!existsSync(configPath)) {
            log.debug(`Config not found: ${configPath}`)
            continue
        }

        log.debug(`Reading config: ${configPath}`)

        try {
            const raw = readFileSync(configPath, 'utf-8')
            const config = parseJsonc<any>(raw)

            // V2 uses `providers`, V1 used `provider`; `settings` is V2, `options` is V1.
            const declared = config.providers?.[PROVIDER_ID] ?? config.provider?.[PROVIDER_ID]
            const baseURL = declared?.settings?.baseURL ?? declared?.options?.baseURL

            if (baseURL) {
                log.debug(`Found baseURL in ${configPath}`)
                return baseURL
            }
        } catch (e) {
            log.warn(`Failed to parse ${configPath}`, {error: String(e)})
        }
    }

    return null
}

export async function createConfigHook(ctx: Plugin.Context): Promise<(() => Promise<void>) | void> {
    try {
        await detectAndRegister(ctx)

        // Registered exactly once. The transform replays from the shared snapshot,
        // so re-registering it on every tick would stack duplicate catalog edits.
        const registration = await ctx.provider.transform(applyLlamaCppProvider)

        const refreshTimer = setInterval(() => {
            refreshModels(ctx).catch((error) => {
                log.warn('Periodic refresh failed', {error: String(error)})
            })
        }, REFRESH_INTERVAL_MS)

        return async () => {
            clearInterval(refreshTimer)
            await registration.dispose()
        }
    } catch (error) {
        log.error('Failed to initialize config hook', {error: String(error)})
    }
}

/**
 * Synchronous, replayable catalog edit.
 *
 * Never awaits and never fetches: all I/O happens before registration and lands
 * in the shared snapshot, per the V2 transform contract.
 */
const applyLlamaCppProvider: ProviderTransform = (editor) => {
    const {baseURL, models} = getLlamaState()
    if (!baseURL || models.length === 0) return

    const apiBaseURL = `${baseURL}/v1`
    const existing = editor.get(PROVIDER_ID)

    if (existing) {
        // Keep the user's declared provider; only correct its identity and endpoint.
        editor.update(PROVIDER_ID, (provider) => {
            provider.name = PROVIDER_NAME
            provider.activation = 'enabled'
            if (!provider.package) provider.package = PROVIDER_PACKAGE
            provider.settings = {...provider.settings, baseURL: apiBaseURL}
        })

        // Merge rather than replace: models declared in opencode.json must survive
        // a refresh even when the server does not advertise them.
        const merged = new Map<string, Model.Info>()
        for (const [id, info] of existing.models) {
            merged.set(id, info)
        }
        for (const discovered of models) {
            const id = modelID(discovered.id)
            merged.set(id, applyModelInfo(discovered, merged.get(id) ?? Model.Info.default(providerID, id)))
        }
        editor.models.set(PROVIDER_ID, [...merged.values()])
    } else {
        // Auto-registration: the provider does not exist yet, so it has to be added
        // outright — `update` is a no-op for an unknown ID.
        editor.add({
            info: {
                ...Provider.Info.empty(providerID),
                name: PROVIDER_NAME,
                activation: 'enabled',
                package: PROVIDER_PACKAGE,
                settings: {baseURL: apiBaseURL},
            },
            models: models.map((discovered) => applyModelInfo(
                discovered,
                Model.Info.default(providerID, modelID(discovered.id)),
            )),
        })
    }
}

/**
 * Resolve input/output modalities.
 *
 * `llama-server` computes `architecture.input_modalities` /
 * `output_modalities` **offline** from the GGUF metadata and projector file —
 * no model load required — so the declared values are authoritative and are
 * available for unloaded and sleeping models too.
 *
 * They must win over name-based guessing: `categorizeModel` returns 'unknown'
 * for most real model names, which would otherwise leave the optimistic
 * `Model.Info.default` value (`input: ["text", "image"]`) in place and falsely
 * advertise vision support.
 *
 * Two documented limits: offline computation cannot detect `video` (only a
 * loaded model reports it), and both arrays fall back to `["text"]` when the
 * metadata or model file is unavailable.
 */
function resolveModalities(model: LlamaCppModel): {input: string[]; output: string[]} {
    const declaredInput = model.architecture?.input_modalities
    const declaredOutput = model.architecture?.output_modalities

    const modelType = categorizeModel(model.id)
    const isEmbedding = modelType === 'embedding'

    let input: string[]
    if (declaredInput?.length) {
        input = [...declaredInput]
    } else if (isEmbedding) {
        input = ['text']
    } else {
        // Conservative: only claim vision when the server or API says so.
        input = model.capabilities?.vision === true ? ['text', 'image'] : ['text']
    }

    let output: string[]
    if (declaredOutput?.length) {
        output = [...declaredOutput]
    } else if (isEmbedding) {
        output = ['embedding']
    } else {
        output = ['text']
    }

    return {input, output}
}

/**
 * `Model.Info` is deeply readonly; the catalog editors hand out mutable copies.
 * This mirrors the SDK's `DeepMutable` for the shallow depth actually touched here.
 */
type MutableModelInfo = {-readonly [K in keyof Model.Info]: Model.Info[K]}

/**
 * Overlay llama.cpp's richer metadata onto a base `Model.Info`.
 * Returns a new object so the caller's base value is never mutated, which keeps
 * the transform replayable.
 */
function applyModelInfo(model: LlamaCppModel, info: Model.Info): Model.Info {
    const next = {...info} as MutableModelInfo

    next.name = formatModelName(model)

    const limit = {...info.limit}
    // Always set: an unresolvable context must not silently inherit the SDK's
    // 200_000, which over-reports against local servers by up to 12x.
    limit.context = resolveContextSize(model) ?? getFallbackContext()

    // `limit.output` stays at the SDK default: llama-server exposes no
    // max-output-tokens field on any endpoint (`--n-predict` is a generation
    // request option defaulting to -1/infinity, not a model cap). Inventing a
    // value here would be worse than leaving the documented default.

    next.limit = limit
    next.time = model.created ? {...info.time, released: model.created} : info.time

    const supportsTools = model.capabilities?.function_calling === true
        || model.supported_parameters?.includes('tools') === true

    const {input, output} = resolveModalities(model)
    next.capabilities = {...info.capabilities, tools: supportsTools, input, output}

    return next
}

async function detectAndRegister(ctx: Plugin.Context): Promise<void> {
    // Applied before any transform can run so the replayed catalog sees it.
    const {fallbackContext} = readOptions(ctx)
    if (fallbackContext !== undefined) {
        setFallbackContext(fallbackContext)
    }

    const baseURL = await resolveBaseURL(ctx)
    if (!baseURL) {
        log.warn('No llama.cpp server found')
        return
    }

    setLlamaBaseURL(baseURL)
    log.info(`Using baseURL: ${baseURL}`)

    if (!(await checkLlamaCppHealth(baseURL))) {
        log.warn('llama.cpp appears to be offline', {baseURL})
        return
    }

    await discoverModels(baseURL)
}

/** Resolution order: plugin options, the live catalog, config files, then a port scan. */
async function resolveBaseURL(ctx: Plugin.Context): Promise<string | null> {
    const {baseURL, ports} = readOptions(ctx)

    if (baseURL) return normalizeBaseURL(baseURL)

    try {
        const {data} = await ctx.provider.list()
        const existing = data?.find((p) => p.id === PROVIDER_ID)
        if (existing) {
            const configured = existing.settings?.baseURL
            if (configured) return normalizeBaseURL(configured)
            log.debug(`${PROVIDER_ID} provider has no baseURL; falling back to auto-detect`)
        }
    } catch (e) {
        log.warn('Failed to read provider list', {error: String(e)})
    }

    const fromConfig = readBaseURLFromConfig()
    if (fromConfig) return normalizeBaseURL(fromConfig)

    return autoDetectLlamaCpp(ports)
}

/**
 * Plugin options, from the config form
 * `{"plugin": ["opencode-plugin-llama.cpp", {"baseURL": "…", "ports": [9931]}]}`.
 *
 * An explicit `baseURL` wins over everything, including a provider already in
 * the catalog. llama.cpp's default port has moved more than once, so this keeps
 * the plugin usable without a code change.
 */
function readOptions(ctx: Plugin.Context): {baseURL?: string; ports: readonly number[]; fallbackContext?: number} {
    const options = ctx.options ?? {}

    const baseURL = typeof options.baseURL === 'string' ? options.baseURL : undefined

    const ports = Array.isArray(options.ports)
        ? options.ports.filter((port): port is number => typeof port === 'number')
        : DEFAULT_LLAMA_CPP_PORTS

    // Only honoured when the server itself reports no context, so this only
    // changes behaviour on setups where discovery is blind.
    const fallbackContext = typeof options.fallbackContext === 'number'
        ? options.fallbackContext
        : undefined

    if (baseURL || fallbackContext || ports !== DEFAULT_LLAMA_CPP_PORTS) {
        log.debug('Using plugin options', {baseURL, ports, fallbackContext})
    }

    return {baseURL, fallbackContext, ports: ports.length > 0 ? ports : DEFAULT_LLAMA_CPP_PORTS}
}

/**
 * Fetch models and publish them to the snapshot. On failure the previous model
 * list is intentionally left in place so a transient outage does not strip the
 * catalog.
 */
/**
 * Re-run discovery now and reload the catalog if the set changed.
 *
 * Shared by the 60s timer and the `/llamacpp-refresh` command so both paths
 * behave identically. Exported for the slash command; the timer below is the
 * only other caller.
 */
export async function refreshNow(ctx: Plugin.Context): Promise<RefreshOutcome> {
    const baseURL = getLlamaBaseURL() ?? await resolveBaseURL(ctx)
    if (!baseURL) return {outcome: 'no-server'}

    if (!(await checkLlamaCppHealth(baseURL))) return {outcome: 'unreachable', baseURL}

    const before = modelSignature(getLlamaState().models)
    await discoverModels(baseURL)

    // Compare by content, not identity: `discoverModels` always installs a fresh
    // array, so an identity check would rebuild the catalog every tick.
    const after = modelSignature(getLlamaState().models)
    if (after === before) return {outcome: 'unchanged', baseURL, count: getLlamaState().models.length}

    await ctx.provider.reload()
    return {outcome: 'changed', baseURL, count: getLlamaState().models.length}
}

async function discoverModels(baseURL: string): Promise<void> {
    let discovered: LlamaCppModel[]
    try {
        discovered = await discoverLlamaCppModels(baseURL)
    } catch (error) {
        log.warn('Model discovery failed', {
            error: error instanceof Error ? error.message : String(error),
        })
        return
    }

    if (discovered.length === 0) {
        log.warn('No models found in llama.cpp')
        return
    }

    // Drop routes whose weights are gone. Filtering here rather than in the
    // catalog transform keeps that callback synchronous, and means the snapshot
    // the session hook reads never contains a model that cannot load.
    const {loadable, unloadable} = await findUnloadableModels(discovered)

    // A stable server with a few stale presets would otherwise emit the same
    // warnings every 60 seconds forever. Report the standing state at `info`
    // on each sweep, and reserve `warn` for the set actually changing, so a
    // newly-broken path is noticed without turning a known condition into a
    // repeating alert.
    const hiddenSignature = unloadable.map((u) => u.model.id).sort().join(',')
    const hiddenChanged = hiddenSignature !== lastHiddenSignature
    lastHiddenSignature = hiddenSignature

    if (hiddenChanged && unloadable.length > 0) {
        for (const {model, modelPath} of unloadable) {
            log.warn('Excluding model with missing weights', {model: model.id, modelPath})
        }
    }

    const models = loadable

    if (models.length === 0) {
        // Every advertised route is broken. Keep whatever was already known
        // rather than emptying the catalog on a bad sweep.
        log.warn('All discovered models have missing weights; keeping previous catalog')
        return
    }

    setLlamaModels(models)
    log.info(
        `Discovered ${models.length} models from llama.cpp`
        + (unloadable.length > 0 ? ` (${unloadable.length} hidden: ${hiddenSignature})` : ''),
    )

    // Warm the cache so the first request does not pay for a redundant fetch.
    try {
        await modelStatusCache.getModels(baseURL, async () => models.map((m) => m.id))
    } catch {
        // Cache warming is best-effort.
    }
}

async function refreshModels(ctx: Plugin.Context): Promise<void> {
    await refreshNow(ctx)
}

/** Stable fingerprint of a discovered model set, for change detection. */
function modelSignature(models: readonly LlamaCppModel[]): string {
    return models.map((m) => `${m.id}@${m.created ?? 0}`).sort().join(',')
}