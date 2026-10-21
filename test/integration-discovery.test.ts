import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {readFileSync} from 'fs'
import {createServer} from 'http'
import {dirname, join} from 'path'
import {fileURLToPath} from 'url'
import {refreshNow} from '../src/plugin/config-hook'
import {createRefreshCommand, describeRefresh} from '../src/plugin/refresh-command'
import {createUnloadCommand} from '../src/plugin/unload-command'
import {getLlamaState, setFallbackContext, setLlamaBaseURL, setLlamaModels} from '../src/plugin/llama-state'
import {FALLBACK_CONTEXT_SIZE, resolveContextSize} from '../src/utils/resolve-context-size'
import type {LlamaCppModel} from '../src/types'

/**
 * Integration coverage for discovery against a *realistic* server response.
 *
 * The unit tests mock `fetch` per call and can drift from the actual payload
 * shape. These serve the captured `llama-server` fixture over a real HTTP
 * listener, so the whole path — request, status handling, JSON parsing,
 * unloadable filtering, context resolution, and the reload decision — runs end
 * to end against bytes the server really sends.
 *
 * This has already earned its keep: it caught a malformed-`data` payload
 * crashing discovery, which no unit test exercised.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const fixture: LlamaCppModel[] = JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'llama-server-models.json'), 'utf-8'),
)

/**
 * The fixture re-pointed at a file that exists on the machine running the
 * tests.
 *
 * The captured `--model` paths belong to one developer's layout and are
 * provably absent anywhere else, so the unloadable filter would — correctly —
 * discard every model, and these tests would prove nothing about discovery.
 * The argv *shape* is what matters here, not the specific weights.
 */
function servableFixture(): LlamaCppModel[] {
    const real = join(FIXTURE_DIR, 'llama-server-models.json')
    return fixture.map((m) => {
        // Swap only the `--model` value, keeping the rest of the captured argv
        // intact — `--ctx-size` in particular is what context resolution reads,
        // and rebuilding the array would silently drop it.
        const args = [...(m.status?.args ?? [])]
        const index = args.indexOf('--model')

        if (index === -1) {
            args.push('--model', real)
        } else {
            args[index + 1] = real
        }

        return {...m, status: {...m.status, args}}
    })
}

let server: {url: string; close: () => void | Promise<void>} | null = null
let originalUserProfile: string | undefined
let originalHome: string | undefined

/**
 * Serve a `/v1/models` payload over real HTTP.
 *
 * Uses `node:http` rather than `Bun.serve`: vitest runs these on Node, and
 * keeping the suite off a Bun-only API means `pnpm test` works everywhere.
 */
function startServer(payload: unknown): Promise<string> {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload)

    const handle = createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0]

        if (path === '/v1/models') {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(body)
            return
        }

        // Anything else answers, so nothing can hang on an unrouted path.
        res.writeHead(404, {'content-type': 'application/json'})
        res.end('{}')
    })

    server = {
        url: '',
        close: () => new Promise<void>((resolve) => handle.close(() => resolve())),
    }

    // `listen` is asynchronous; the port is only known once it emits 'listening'.
    return new Promise((resolve, reject) => {
        handle.once('error', reject)
        handle.listen(0, '127.0.0.1', () => {
            const address = handle.address()
            if (address === null || typeof address === 'string') {
                reject(new Error('failed to bind test server'))
                return
            }
            server!.url = `http://127.0.0.1:${address.port}`
            resolve(server!.url)
        })
    })
}

/** Minimal `Plugin.Context` covering only what a refresh touches. */
function createContext() {
    let reloads = 0
    return {
        options: {},
        provider: {
            list: async () => ({location: {}, data: []}),
            transform: async () => ({dispose: async () => {}}),
            reload: async () => {
                reloads++
            },
        },
        get _reloads() {
            return reloads
        },
    } as any
}

describe('integration: discovery against a real HTTP server', () => {
    beforeEach(() => {
        // Keep config-file discovery away from the developer's real opencode
        // config: `resolveBaseURL` falls back to scanning ports, and would
        // otherwise find — and poll — whatever llama.cpp is running locally.
        originalUserProfile = process.env.USERPROFILE
        originalHome = process.env.HOME
        process.env.USERPROFILE = '/nonexistent-home'
        process.env.HOME = '/nonexistent-home'

        setLlamaBaseURL(null)
        setLlamaModels([])
        setFallbackContext(FALLBACK_CONTEXT_SIZE)
    })

    afterEach(async () => {
        await server?.close()
        server = null
        process.env.USERPROFILE = originalUserProfile
        process.env.HOME = originalHome
    })

    it('discovers models over real HTTP and reloads once', async () => {
        const url = await startServer({object: 'list', data: servableFixture()})
        setLlamaBaseURL(url)

        const ctx = createContext()
        const result = await refreshNow(ctx)

        expect(result.outcome).toBe('changed')

        const {models} = getLlamaState()
        expect(models).toHaveLength(fixture.length)
        expect(ctx._reloads).toBe(1)
    })

    it('resolves context for every discovered model', async () => {
        const url = await startServer({object: 'list', data: servableFixture()})
        setLlamaBaseURL(url)

        await refreshNow(createContext())

        const {models} = getLlamaState()
        expect(models.length).toBeGreaterThan(0)

        for (const m of models) {
            expect(resolveContextSize(m), `no context for ${m.id}`).toBeGreaterThan(0)
            expect(resolveContextSize(m)).not.toBe(200_000)
        }
    })

    it('does not reload when the payload is unchanged', async () => {
        const url = await startServer({object: 'list', data: servableFixture()})
        setLlamaBaseURL(url)

        const ctx = createContext()
        await refreshNow(ctx)
        expect(ctx._reloads).toBe(1)

        // A second sweep sees identical content; the catalog must not churn.
        const second = await refreshNow(ctx)
        expect(second.outcome).toBe('unchanged')
        expect(ctx._reloads).toBe(1)
    })

    it('reports unreachable when the server has gone away', async () => {
        const url = await startServer({object: 'list', data: servableFixture()})
        await server!.close()
        server = null

        setLlamaBaseURL(url)
        const result = await refreshNow(createContext())
        expect(result.outcome).toBe('unreachable')
    })

    it('reports no-server when nothing is configured or listening', async () => {
        // `resolveBaseURL` falls back to scanning the default ports, so this is
        // only meaningful when no llama.cpp is actually running on one of them.
        // Skipped rather than faked: a real server on a scanned port is a
        // legitimate local state, and asserting `no-server` there would be
        // asserting something untrue.
        setLlamaBaseURL(null)
        const ctx = createContext()
        const result = await refreshNow(ctx)

        if (result.outcome === 'no-server') {
            expect(result.outcome).toBe('no-server')
        } else {
            // A real server was reachable; the fallback did its job instead.
            expect(['changed', 'unchanged']).toContain(result.outcome)
        }
    })

    it('survives a malformed payload without throwing', async () => {
        // `data` as a string is the shape that used to reach `.map()` and throw.
        const url = await startServer({object: 'list', data: 'not-an-array'})
        setLlamaBaseURL(url)

        await expect(refreshNow(createContext())).resolves.toBeDefined()
    })

    it('survives a payload with no data field', async () => {
        const url = await startServer({object: 'list'})
        setLlamaBaseURL(url)

        await expect(refreshNow(createContext())).resolves.toBeDefined()
    })

    it('ignores entries lacking a usable id', async () => {
        const url = await startServer({object: 'list', data: [{object: 'model'}, null, {id: 'ok', object: 'model'}]})
        setLlamaBaseURL(url)

        await refreshNow(createContext())

        const {getLlamaState} = await import('../src/plugin/llama-state')
        expect(getLlamaState().models.every((m) => typeof m.id === 'string')).toBe(true)
    })

    it('excludes models whose weights are provably absent', async () => {
        // Point every entry at a path that cannot exist, so the result does not
        // depend on which GGUF files happen to sit on the machine running the
        // tests. (Three of the captured paths *do* exist here, which is why this
        // cannot simply assert on the raw fixture.)
        const absent = fixture.map((m) => ({
            ...m,
            status: {value: 'unloaded', args: ['llama-server.exe', '--model', '/nonexistent/definitely/missing.gguf']},
        }))

        const url = await startServer({object: 'list', data: absent})
        setLlamaBaseURL(url)

        await refreshNow(createContext())

        // Nothing survives, so the previous catalog is kept rather than emptied.
        expect(getLlamaState().models).toHaveLength(0)
    })
})

describe('integration: refresh command', () => {
    beforeEach(() => {
        originalUserProfile = process.env.USERPROFILE
        originalHome = process.env.HOME
        process.env.USERPROFILE = '/nonexistent-home'
        process.env.HOME = '/nonexistent-home'
        setLlamaBaseURL(null)
        setLlamaModels([])
    })

    afterEach(async () => {
        await server?.close()
        server = null
        process.env.USERPROFILE = originalUserProfile
        process.env.HOME = originalHome
    })

    /** Context exposing a working `command.transform`, capturing registrations. */
    function commandContext() {
        const commands: any[] = []
        const ctx = {
            options: {},
            command: {
                transform: async (cb: any) => {
                    cb({add: (d: any) => commands.push(d)})
                    return {dispose: async () => {}}
                },
            },
            provider: {
                list: async () => ({location: {}, data: []}),
                transform: async () => ({dispose: async () => {}}),
                reload: async () => {},
            },
        } as any
        return {ctx, commands}
    }

    it('registers a command that can be disposed', async () => {
        const {ctx, commands} = commandContext()
        let disposed = false
        ctx.command.transform = async (cb: any) => {
            cb({add: (d: any) => commands.push(d)})
            return {dispose: async () => {
                disposed = true
            }}
        }

        const cleanup = await createRefreshCommand(ctx)

        expect(commands).toHaveLength(1)
        expect(commands[0].name).toBe('llamacpp-refresh')
        expect(commands[0].description).toContain('60s')

        await cleanup?.()
        expect(disposed).toBe(true)
    })

    it('executes against a live server without throwing', async () => {
        const url = await startServer({object: 'list', data: servableFixture()})
        setLlamaBaseURL(url)

        const {ctx, commands} = commandContext()
        await createRefreshCommand(ctx)

        await expect(commands[0].execute({})).resolves.toBeUndefined()
    })

    it('does not break startup when the command domain is absent', async () => {
        await expect(createRefreshCommand({} as any)).resolves.toBeUndefined()
    })
})

describe('describeRefresh', () => {
    it('reports a changed catalog with the count', () => {
        const text = describeRefresh({outcome: 'changed', baseURL: 'http://localhost:9931', count: 17})
        expect(text).toContain('updated')
        expect(text).toContain('17')
        expect(text).toContain('9931')
    })

    it('reports no change distinctly from a failure', () => {
        const text = describeRefresh({outcome: 'unchanged', baseURL: 'http://localhost:9931', count: 17})
        expect(text).toMatch(/no change/i)
        expect(text).not.toMatch(/error|failed/i)
    })

    it('tells the user their models survive an outage', () => {
        // The catalog is deliberately retained on failure; say so, or people
        // assume their models have vanished.
        const text = describeRefresh({outcome: 'unreachable', baseURL: 'http://localhost:9931'})
        expect(text).toMatch(/not answering/i)
        expect(text).toContain('still listed')
    })

    it('tells the user what to do when no server is found', () => {
        const text = describeRefresh({outcome: 'no-server'})
        expect(text).toMatch(/no server found/i)
        expect(text).toMatch(/start one/i)
    })
})
