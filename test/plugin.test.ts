import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {LlamaCppModel} from '../src/types'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

// Mock AbortSignal.timeout for older Node versions
if (!global.AbortSignal.timeout) {
    global.AbortSignal.timeout = vi.fn(() => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 3000)
        return controller.signal
    })
}

const PROVIDER_ID = 'llama.cpp'

interface MockProviderEntry {
    provider: Record<string, any>
    models: Map<string, Record<string, any>>
}

function toRecord(entry: MockProviderEntry) {
    return {provider: entry.provider, models: entry.models}
}

/**
 * Mock of the V2 server context, shaped after the installed `@opencode/plugin`
 * 2.0.28 `.d.ts`: `ctx.provider.transform` receives a `ProviderEditor`, and
 * `ctx.provider.list()` is the HTTP client returning `{location, data}`.
 *
 * The editor is a real working implementation (not a spy) so tests can assert on
 * the resulting catalog rather than merely that a callback ran.
 */
function createMockContext(
    declaredProviders: Array<{id: string; settings?: any; models?: Record<string, any>[]}> = [],
    options: Record<string, any> = {},
) {
    const providers = new Map<string, MockProviderEntry>()
    const registrations: any[] = []
    const sessionHooks: Array<{name: string; callback: Function}> = []

    for (const declared of declaredProviders) {
        providers.set(declared.id, {
            provider: {
                id: declared.id,
                name: declared.id,
                activation: 'auto',
                package: '@ai-sdk/openai-compatible',
                ...(declared.settings ? {settings: declared.settings} : {}),
            },
            models: new Map((declared.models ?? []).map((m) => [m.id, {...m}])),
        })
    }

    const editor = {
        list: () => [...providers.values()].map(toRecord),
        get: (id: string) => (providers.has(id) ? toRecord(providers.get(id)!) : undefined),
        add: vi.fn(({info, models}: {info: any; models: any[]}) => {
            providers.set(info.id, {
                provider: {...info},
                models: new Map(models.map((m) => [m.id, {...m}])),
            })
        }),
        update: vi.fn((id: string, fn: (p: any) => void) => {
            const entry = providers.get(id)
            if (!entry) return
            fn(entry.provider)
        }),
        remove: vi.fn((id: string) => {
            providers.delete(id)
        }),
        models: {
            set: vi.fn((id: string, models: any[]) => {
                const entry = providers.get(id)
                if (!entry) return
                entry.models = new Map(models.map((m) => [m.id, {...m}]))
            }),
            update: vi.fn((id: string, modelID: string, fn: (m: any) => void) => {
                const entry = providers.get(id)
                const existing = entry?.models.get(modelID)
                if (!existing) return
                fn(existing)
            }),
            remove: vi.fn((id: string, modelID: string) => {
                providers.get(id)?.models.delete(modelID)
            }),
        },
    }

    // Transforms are replayable state edits: a reload re-invokes every live one.
    const liveTransforms = new Set<(input: typeof editor) => void>()

    // Mirrors the real `ModelEditor` surface used by tool-support promotion.
    const modelEditor = () => ({
        get: (pid: string, mid: string) => {
            const model = providers.get(pid)?.models.get(mid)
            return model ? {...model} : undefined
        },
        update: vi.fn((pid: string, mid: string, fn: (m: any) => void) => {
            const existing = providers.get(pid)?.models.get(mid)
            if (existing) fn(existing)
        }),
        remove: vi.fn(),
    })

    return {
        app: {version: '2.0.28'},
        location: {directory: '/tmp', project: {id: 'test-project', directory: '/tmp', canonical: '/tmp'}},
        options,
        provider: {
            list: vi.fn(async () => ({
                location: {},
                data: [...providers.values()].map((entry) => entry.provider),
            })),
            transform: vi.fn(async (callback: (input: typeof editor) => void) => {
                callback(editor)
                liveTransforms.add(callback)
                const reg = {
                    dispose: vi.fn(async () => {
                        liveTransforms.delete(callback)
                    }),
                }
                registrations.push(reg)
                return reg
            }),
            reload: vi.fn(async () => {
                for (const transform of liveTransforms) transform(editor)
            }),
        },
        model: {
            transform: vi.fn(async (callback: (input: any) => void) => {
                callback(modelEditor())
                const reg = {dispose: vi.fn().mockResolvedValue(undefined)}
                registrations.push(reg)
                return reg
            }),
            reload: vi.fn().mockResolvedValue(undefined),
        },
        session: {
            hook: vi.fn(async (name: string, callback: Function) => {
                sessionHooks.push({name, callback})
                const reg = {dispose: vi.fn().mockResolvedValue(undefined)}
                registrations.push(reg)
                return reg
            }),
        },
        event: {
            subscribe: vi.fn().mockImplementation(async function* () {
                return
            }),
        },
        storage: {
            get: vi.fn().mockResolvedValue(undefined),
            set: vi.fn().mockResolvedValue(undefined),
            remove: vi.fn().mockResolvedValue(undefined),
        },
        // Test affordances
        _editor: editor,
        _providers: providers,
        _sessionHooks: sessionHooks,
        _registrations: registrations,
    }
}

const discoveredModels: LlamaCppModel[] = [
    {id: 'qwen/qwen3-30b-a3b', object: 'model', created: 1_700_000_000, owned_by: 'local', status: {value: 'loaded'}},
    {id: 'nomic-embed-text', object: 'model', created: 1_600_000_000, owned_by: 'local', status: {value: 'loaded'}},
]

/** Health check then model discovery, both GET /v1/models. */
function mockServerOnline(models: LlamaCppModel[] = discoveredModels) {
    mockFetch.mockResolvedValue({ok: true, json: async () => ({data: models})})
}

function mockServerOffline() {
    mockFetch.mockRejectedValue(new Error('Connection refused'))
}

describe('Llama.cpp Plugin (V2)', () => {
    let mockCtx: ReturnType<typeof createMockContext>
    let plugin: any
    let originalUserProfile: string | undefined
    let originalHome: string | undefined

    beforeEach(async () => {
        mockFetch.mockReset()
        // Keep config-file discovery off the real machine's opencode config.
        originalUserProfile = process.env.USERPROFILE
        originalHome = process.env.HOME
        process.env.USERPROFILE = '/nonexistent-home'
        process.env.HOME = '/nonexistent-home'

        // llama-state is module-level; reset it between tests.
        vi.resetModules()
        plugin = (await import('../src')).LlamaCppPlugin
    })

    afterEach(() => {
        vi.restoreAllMocks()
        process.env.USERPROFILE = originalUserProfile
        process.env.HOME = originalHome
    })

    describe('Plugin Definition', () => {
        it('should have correct V2 plugin shape', () => {
            expect(plugin).toBeDefined()
            expect(plugin.id).toBe('llama-cpp')
            expect(typeof plugin.setup).toBe('function')
        })
    })

    describe('Setup', () => {
        it('should initialize successfully and return a cleanup function', async () => {
            mockServerOffline()
            mockCtx = createMockContext()

            const cleanup = await plugin.setup(mockCtx)
            await cleanup()

            expect(typeof cleanup).toBe('function')
        })

        it('registers exactly one provider transform', async () => {
            mockServerOffline()
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            // Re-registering on each refresh tick would stack duplicate catalog edits.
            expect(mockCtx.provider.transform).toHaveBeenCalledTimes(1)
        })

        it('registers a session "context" hook', async () => {
            mockServerOffline()
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            expect(mockCtx.session.hook).toHaveBeenCalledWith('context', expect.any(Function))
        })
    })

    describe('Provider registration', () => {
        it('adds the provider when it is not already declared', async () => {
            mockServerOnline()
            // No declared provider, and config discovery is pointed at a nonexistent
            // home; auto-detection scans 1234/8080/11434 and 1234 responds.
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            // `update` cannot create a provider, so `add` is the load-bearing call.
            expect(mockCtx._editor.add).toHaveBeenCalledTimes(1)

            const entry = mockCtx._providers.get(PROVIDER_ID)
            expect(entry).toBeDefined()
            expect(entry!.provider.package).toBe('@opencode/ai/providers/openai-compatible')
            expect(entry!.provider.activation).toBe('enabled')
            expect(entry!.provider.settings.baseURL).toBe('http://127.0.0.1:1234/v1')
            expect([...entry!.models.keys()]).toEqual(['qwen/qwen3-30b-a3b', 'nomic-embed-text'])
        })

        it('enriches discovered model metadata', async () => {
            mockServerOnline([
                {
                    id: 'qwen/qwen3-30b-a3b',
                    object: 'model',
                    created: 1_700_000_000,
                    owned_by: 'local',
                    context_length: 32_000,
                    capabilities: {function_calling: true, vision: true},
                    meta: {n_ctx_train: 131072},
                },
            ])
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            const model = mockCtx._providers.get(PROVIDER_ID)!.models.get('qwen/qwen3-30b-a3b')
            expect(model.name).toBe('Qwen3 30B A3B')
            expect(model.limit.context).toBe(32_000)
            // No server endpoint reports a max-output cap, so the SDK default stands.
            expect(model.limit.output).toBe(32_000)
            expect(model.time.released).toBe(1_700_000_000)
            expect(model.capabilities.tools).toBe(true)
            expect(model.capabilities.input).toEqual(['text', 'image'])
            expect(model.capabilities.output).toEqual(['text'])
        })

        it('classifies embedding models by output modality', async () => {
            mockServerOnline()
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            const model = mockCtx._providers.get(PROVIDER_ID)!.models.get('nomic-embed-text')
            expect(model.capabilities.output).toEqual(['embedding'])
            expect(model.capabilities.input).toEqual(['text'])
        })

        it('updates rather than replaces an already-declared provider', async () => {
            mockServerOnline()
            mockCtx = createMockContext([{
                id: PROVIDER_ID,
                settings: {baseURL: 'http://localhost:9931'},
            }])

            await plugin.setup(mockCtx)

            expect(mockCtx._editor.add).not.toHaveBeenCalled()
            expect(mockCtx._editor.update).toHaveBeenCalled()

            const entry = mockCtx._providers.get(PROVIDER_ID)!
            expect(entry.provider.name).toBe('llama.cpp (local)')
            // Normalized and given the /v1 suffix the AI SDK driver expects.
            expect(entry.provider.settings.baseURL).toBe('http://localhost:9931/v1')
            expect([...entry.models.keys()]).toEqual(['qwen/qwen3-30b-a3b', 'nomic-embed-text'])
        })

        it('preserves models declared in config that the server does not advertise', async () => {
            mockServerOnline()
            mockCtx = createMockContext([{
                id: PROVIDER_ID,
                settings: {baseURL: 'http://localhost:9931'},
                models: [{id: 'hand-written-model', name: 'Hand Written', enabled: true}],
            }])

            await plugin.setup(mockCtx)

            const keys = [...mockCtx._providers.get(PROVIDER_ID)!.models.keys()]
            expect(keys).toContain('hand-written-model')
            expect(keys).toContain('qwen/qwen3-30b-a3b')
        })

        it('reads the context size from --ctx-size in status.args', async () => {
            // Router mode reports no context field for an unloaded model; the real
            // value only appears in the per-model launch args.
            mockServerOnline([{
                id: 'JackOD-9B-Coder-MTP-v4',
                object: 'model',
                created: 1_792_114_419,
                owned_by: 'llamacpp',
                architecture: {input_modalities: ['text'], output_modalities: ['text']},
                status: {value: 'unloaded', args: ['llama-server.exe', '--ctx-size', '65536', '--port', '0']},
            } as any])
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            const model = mockCtx._providers.get(PROVIDER_ID)!.models.get('JackOD-9B-Coder-MTP-v4')
            // Not the 200_000 Model.Info.default fallback.
            expect(model.limit.context).toBe(65536)
        })

        it('accepts the short -c alias for context size', async () => {
            mockServerOnline([{
                id: 'short-alias-model',
                object: 'model',
                created: 1_792_114_419,
                owned_by: 'llamacpp',
                status: {value: 'unloaded', args: ['llama-server.exe', '-c', '32768']},
            } as any])
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            expect(mockCtx._providers.get(PROVIDER_ID)!.models.get('short-alias-model').limit.context)
                .toBe(32768)
        })

        it('does not treat n_ctx_train as the serving context', async () => {
            // meta is only forwarded once loaded, and n_ctx_train is the trained
            // maximum rather than the configured serving window.
            mockServerOnline([{
                id: 'loaded-model',
                object: 'model',
                created: 1_792_114_419,
                owned_by: 'llamacpp',
                meta: {n_ctx_train: 131072},
                status: {value: 'loaded', args: ['llama-server.exe', '--ctx-size', '65536']},
            } as any])
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            expect(mockCtx._providers.get(PROVIDER_ID)!.models.get('loaded-model').limit.context)
                .toBe(65536)
        })

        it('prefers declared modalities over the optimistic defaults', async () => {
            mockServerOnline([{
                id: 'JackOD-9B-Coder-MTP-v4',
                object: 'model',
                created: 1_792_114_419,
                owned_by: 'llamacpp',
                architecture: {input_modalities: ['text'], output_modalities: ['text']},
                status: {args: ['--ctx-size', '131072']},
            } as any])
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            const model = mockCtx._providers.get(PROVIDER_ID)!.models.get('JackOD-9B-Coder-MTP-v4')
            // Model.Info.default claims image input; the server says text-only.
            expect(model.capabilities.input).toEqual(['text'])
            expect(model.capabilities.output).toEqual(['text'])
        })

        it('does not claim vision for unclassifiable models with no declared modalities', async () => {
            // "JackOD-9B-Coder" matches none of categorizeModel's chat keywords.
            mockServerOnline([{
                id: 'JackOD-9B-Coder',
                object: 'model',
                created: 1_792_114_419,
                owned_by: 'llamacpp',
            } as any])
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            const model = mockCtx._providers.get(PROVIDER_ID)!.models.get('JackOD-9B-Coder')
            expect(model.capabilities.input).toEqual(['text'])
        })

        it('keeps image input when the server declares it', async () => {
            mockServerOnline([{
                id: 'gemma-4-E4B-MTP',
                object: 'model',
                created: 1_792_114_419,
                owned_by: 'llamacpp',
                architecture: {input_modalities: ['text', 'image', 'audio'], output_modalities: ['text']},
            } as any])
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            const model = mockCtx._providers.get(PROVIDER_ID)!.models.get('gemma-4-E4B-MTP')
            expect(model.capabilities.input).toEqual(['text', 'image', 'audio'])
        })

        it('does not register anything when the server is offline', async () => {
            mockServerOffline()
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            expect(mockCtx._editor.add).not.toHaveBeenCalled()
            expect(mockCtx._providers.has(PROVIDER_ID)).toBe(false)
        })
    })

    describe('Plugin options', () => {
        it('honours an explicit baseURL option above everything else', async () => {
            mockServerOnline()
            // A declared provider points elsewhere; the option must still win.
            mockCtx = createMockContext(
                [{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9999'}}],
                {baseURL: 'http://localhost:9931'},
            )

            await plugin.setup(mockCtx)

            expect(mockCtx._providers.get(PROVIDER_ID)!.provider.settings.baseURL)
                .toBe('http://localhost:9931/v1')
        })

        it('restricts auto-detection to the configured ports', async () => {
            mockServerOnline()
            mockCtx = createMockContext([], {ports: [9931]})

            await plugin.setup(mockCtx)

            expect(mockCtx._providers.get(PROVIDER_ID)!.provider.settings.baseURL)
                .toBe('http://127.0.0.1:9931/v1')
        })

        it('falls back to the default port list when options are absent', async () => {
            mockServerOnline()
            mockCtx = createMockContext()

            await plugin.setup(mockCtx)

            expect(mockCtx._providers.get(PROVIDER_ID)!.provider.settings.baseURL)
                .toBe('http://127.0.0.1:1234/v1')
        })
    })

    describe('Periodic refresh', () => {
        beforeEach(() => {
            vi.useFakeTimers()
        })

        afterEach(() => {
            vi.useRealTimers()
        })

        it('reloads the catalog when the discovered set changes', async () => {
            mockServerOnline()
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])

            const cleanup = await plugin.setup(mockCtx)
            expect(mockCtx.provider.reload).not.toHaveBeenCalled()

            mockServerOnline([...discoveredModels, {
                id: 'brand-new-model', object: 'model', created: 1_800_000_000, owned_by: 'local',
            }])

            await vi.advanceTimersByTimeAsync(60_000)

            expect(mockCtx.provider.reload).toHaveBeenCalledTimes(1)
            expect([...mockCtx._providers.get(PROVIDER_ID)!.models.keys()]).toContain('brand-new-model')
            await cleanup()
        })

        it('does not reload the catalog when nothing changed', async () => {
            mockServerOnline()
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])

            const cleanup = await plugin.setup(mockCtx)
            await vi.advanceTimersByTimeAsync(180_000)

            expect(mockCtx.provider.reload).not.toHaveBeenCalled()
            await cleanup()
        })

        it('keeps the previous models when the server goes offline', async () => {
            mockServerOnline()
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])

            const cleanup = await plugin.setup(mockCtx)

            mockServerOffline()
            await vi.advanceTimersByTimeAsync(60_000)

            expect([...mockCtx._providers.get(PROVIDER_ID)!.models.keys()])
                .toEqual(['qwen/qwen3-30b-a3b', 'nomic-embed-text'])
            await cleanup()
        })
    })

    describe('Model validation hook', () => {
        it('warns in the system prompt when the model is not loaded', async () => {
            mockServerOnline()
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])
            await plugin.setup(mockCtx)

            const hook = mockCtx._sessionHooks.find((h) => h.name === 'context')!.callback
            const event: any = {
                // Not among the models the server reported, so validation fails.
                model: {id: 'never-loaded-model', providerID: PROVIDER_ID},
                system: [],
                options: {},
                messages: [],
                tools: {},
                agent: 'build',
                sessionID: 'ses_test',
            }

            await hook(event)

            expect(event.system).toHaveLength(1)
            expect(event.system[0].text).toContain('not currently loaded')
        })

        it('stays silent when the model is loaded', async () => {
            mockServerOnline()
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])
            await plugin.setup(mockCtx)

            const hook = mockCtx._sessionHooks.find((h) => h.name === 'context')!.callback
            const event: any = {
                model: {id: 'qwen/qwen3-30b-a3b', providerID: PROVIDER_ID},
                system: [],
                options: {},
                messages: [],
                tools: {},
                agent: 'build',
                sessionID: 'ses_test',
            }

            await hook(event)

            expect(event.system).toHaveLength(0)
        })

        it('stays silent for other providers', async () => {
            mockServerOnline()
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])
            await plugin.setup(mockCtx)

            const hook = mockCtx._sessionHooks.find((h) => h.name === 'context')!.callback
            const event: any = {
                model: {id: 'gpt-4o', providerID: 'openai'},
                system: [],
                options: {},
                messages: [],
                tools: {},
                agent: 'build',
                sessionID: 'ses_test',
            }

            await hook(event)

            expect(event.system).toHaveLength(0)
        })
    })

    describe('Tool support detection', () => {
        /** Let the detached probe settle. */
        const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

        const runHook = async (mockCtx: any, modelID: string) => {
            const hook = mockCtx._sessionHooks.find((h) => h.name === 'context')!.callback
            const event: any = {
                model: {id: modelID, providerID: PROVIDER_ID},
                system: [],
                options: {},
                messages: [],
                tools: {},
                agent: 'build',
                sessionID: 'ses_test',
            }
            await hook(event)
        }

        beforeEach(async () => {
            const {resetToolSupportCache} = await import('../src/plugin/tool-support')
            resetToolSupportCache()
        })

        it('promotes tools when the chat template supports them', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    data: discoveredModels,
                    chat_template_caps: {supports_tools: true, supports_tool_calls: true},
                }),
            })
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])
            await plugin.setup(mockCtx)

            await runHook(mockCtx, 'qwen/qwen3-30b-a3b')
            await settle()

            expect(mockCtx._providers.get(PROVIDER_ID)!.models.get('qwen/qwen3-30b-a3b').capabilities.tools)
                .toBe(true)
            expect(mockCtx.model.reload).toHaveBeenCalled()
        })

        it('probes /props with the model query param', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({data: discoveredModels, chat_template_caps: {supports_tools: true}}),
            })
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])
            await plugin.setup(mockCtx)
            mockFetch.mockClear()

            await runHook(mockCtx, 'qwen/qwen3-30b-a3b')
            await settle()

            // Router mode requires ?model=; a bare /props returns HTTP 400.
            const urls = mockFetch.mock.calls.map((c) => String(c[0]))
            expect(urls.some((u) => u.includes('/props?model='))).toBe(true)
        })

        it('never demotes tools the user set deliberately', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({data: discoveredModels, chat_template_caps: {supports_tools: false}}),
            })
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])
            await plugin.setup(mockCtx)
            // Simulate a user-enabled model.
            mockCtx._providers.get(PROVIDER_ID)!.models.get('qwen/qwen3-30b-a3b').capabilities.tools = true

            await runHook(mockCtx, 'qwen/qwen3-30b-a3b')
            await settle()

            expect(mockCtx._providers.get(PROVIDER_ID)!.models.get('qwen/qwen3-30b-a3b').capabilities.tools)
                .toBe(true)
        })

        it('probes each model at most once', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({data: discoveredModels, chat_template_caps: {supports_tools: true}}),
            })
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])
            await plugin.setup(mockCtx)
            mockFetch.mockClear()

            await runHook(mockCtx, 'qwen/qwen3-30b-a3b')
            await settle()
            const afterFirst = mockFetch.mock.calls.length
            await runHook(mockCtx, 'qwen/qwen3-30b-a3b')
            await settle()

            // Cached: no second probe for the same model.
            expect(mockFetch.mock.calls.length).toBe(afterFirst)
        })

        it('never probes an unloaded model, because /props would autoload it', async () => {
            mockServerOnline([{
                id: 'cold-model', object: 'model', created: 1_700_000_000, owned_by: 'local',
                status: {value: 'unloaded'},
            }])
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])
            await plugin.setup(mockCtx)
            mockFetch.mockClear()

            await runHook(mockCtx, 'cold-model')
            await settle()

            // Aborting the fetch would not cancel a server-side autoload, so the
            // probe must not be issued at all.
            const urls = mockFetch.mock.calls.map((c) => String(c[0]))
            expect(urls.some((u) => u.includes('/props'))).toBe(false)
        })

        it('leaves support unknown when the probe times out', async () => {
            mockServerOnline()
            mockCtx = createMockContext([{id: PROVIDER_ID, settings: {baseURL: 'http://localhost:9931'}}])
            await plugin.setup(mockCtx)

            // /props fails (endpoint unavailable) after setup.
            mockFetch.mockRejectedValue(new Error('timeout'))
            await runHook(mockCtx, 'nomic-embed-text')
            await settle()

            expect(mockCtx.model.transform).not.toHaveBeenCalled()
            // Still probeable on a later turn.
            const {getCachedToolSupport} = await import('../src/plugin/tool-support')
            expect(getCachedToolSupport('nomic-embed-text')).toBeUndefined()
        })
    })
})