import {Model, Provider} from '@opencode/plugin'
import type {Plugin} from '@opencode/plugin'
import {existsSync, readFileSync} from 'fs'
import {join} from 'path'
import stripJsonComments from 'strip-json-comments'
import {modelStatusCache} from '../cache'
import {categorizeModel, formatModelName} from '../utils'
import {autoDetectLlamaCpp, checkLlamaCppHealth, DEFAULT_LLAMA_CPP_PORTS, discoverLlamaCppModels, normalizeBaseURL} from '../utils/llama-cpp-api'
import type {LlamaCppModel} from '../types'
import {log} from '../utils/log'
import {getLlamaBaseURL, getLlamaState, setLlamaBaseURL, setLlamaModels} from './llama-state'

/** Provider ID this plugin owns. */
const PROVIDER_ID = 'llama.cpp'
const PROVIDER_NAME = 'llama.cpp (local)'
/** Driver package OpenCode loads for an OpenAI-compatible endpoint. */
const PROVIDER_PACKAGE = '@opencode/ai/providers/openai-compatible'
const REFRESH_INTERVAL_MS = 60_000

/** The callback type `ctx.provider.transform` expects. */
type ProviderTransform = Parameters<Plugin.Context['provider']['transform']>[0]

const providerID = PROVIDER_ID as Provider.ID

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
            const cleaned = stripJsonComments(raw).replace(/,\s*([\]}])/g, '$1')
            const config = JSON.parse(cleaned)

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
 * Resolve the model's effective context size.
 *
 * `llama-server`'s router mode reports no context field for an *unloaded*
 * model — the value only appears as `-c` / `--ctx-size` in the per-model launch
 * args in `status.args`. Without this the plugin falls back to
 * `Model.Info.default`'s 200_000, over-reporting by up to 3x against servers
 * running 65_536–131_072, which causes context-overflow failures.
 *
 * Note this is the *serving* context (`n_ctx`), not `meta.n_ctx_train`, which
 * is the model's trained maximum and is only present once loaded.
 */
function resolveContextSize(model: LlamaCppModel): number | undefined {
    if (model.context_length) return model.context_length
    if (model.context_window) return model.context_window

    const args = model.status?.args
    if (!Array.isArray(args)) return undefined

    // llama.cpp accepts both the short and long spelling.
    for (const flag of ['--ctx-size', '-c']) {
        const index = args.indexOf(flag)
        if (index === -1) continue
        const value = Number(args[index + 1])
        if (Number.isFinite(value) && value > 0) return value
    }

    return undefined
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
    const contextSize = resolveContextSize(model)
    if (contextSize) limit.context = contextSize

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
function readOptions(ctx: Plugin.Context): {baseURL?: string; ports: readonly number[]} {
    const options = ctx.options ?? {}

    const baseURL = typeof options.baseURL === 'string' ? options.baseURL : undefined

    const ports = Array.isArray(options.ports)
        ? options.ports.filter((port): port is number => typeof port === 'number')
        : DEFAULT_LLAMA_CPP_PORTS

    if (baseURL || ports !== DEFAULT_LLAMA_CPP_PORTS) {
        log.debug('Using plugin options', {baseURL, ports})
    }

    return {baseURL, ports: ports.length > 0 ? ports : DEFAULT_LLAMA_CPP_PORTS}
}

/**
 * Fetch models and publish them to the snapshot. On failure the previous model
 * list is intentionally left in place so a transient outage does not strip the
 * catalog.
 */
async function discoverModels(baseURL: string): Promise<void> {
    let models: LlamaCppModel[]
    try {
        models = await discoverLlamaCppModels(baseURL)
    } catch (error) {
        log.warn('Model discovery failed', {
            error: error instanceof Error ? error.message : String(error),
        })
        return
    }

    if (models.length === 0) {
        log.warn('No models found in llama.cpp')
        return
    }

    setLlamaModels(models)
    log.info(`Discovered ${models.length} models from llama.cpp`)

    // Warm the cache so the first request does not pay for a redundant fetch.
    try {
        await modelStatusCache.getModels(baseURL, async () => models.map((m) => m.id))
    } catch {
        // Cache warming is best-effort.
    }
}

async function refreshModels(ctx: Plugin.Context): Promise<void> {
    const baseURL = getLlamaBaseURL() ?? await resolveBaseURL(ctx)
    if (!baseURL) return

    if (!(await checkLlamaCppHealth(baseURL))) return

    const before = modelSignature(getLlamaState().models)
    await discoverModels(baseURL)

    // Compare by content, not identity: `discoverModels` always installs a fresh
    // array, so an identity check would rebuild the catalog every tick.
    if (modelSignature(getLlamaState().models) === before) {
        return
    }

    await ctx.provider.reload()
}

/** Stable fingerprint of a discovered model set, for change detection. */
function modelSignature(models: readonly LlamaCppModel[]): string {
    return models.map((m) => `${m.id}@${m.created ?? 0}`).sort().join(',')
}