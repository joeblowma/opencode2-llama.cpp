import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createServer} from 'http'
import {
    describeUnload,
    parseUnloadTarget,
    performUnload,
    resolveTarget,
    createUnloadCommand,
} from '../src/plugin/unload-command'
import {
    getActiveModel,
    setActiveModel,
    setLlamaBaseURL,
    setLlamaModels,
} from '../src/plugin/llama-state'
import type {LlamaCppModel} from '../src/types'

const model = (id: string, status?: string): LlamaCppModel => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'llamacpp',
    ...(status ? {status: {value: status}} : {}),
})

/** Minimal router-mode stand-in that records what was unloaded. */
let server: {url: string; close: () => Promise<void>; unloaded: string[]; fail?: string} | null = null

function startServer(): Promise<string> {
    const unloaded: string[] = []
    const state = {unloaded, fail: undefined as string | undefined}

    const handle = createServer((req, res) => {
        let body = ''
        req.on('data', (c) => body += c)
        req.on('end', () => {
            const path = (req.url ?? '/').split('?')[0]

            if (req.method === 'POST' && path === '/models/unload') {
                if (state.fail) {
                    res.writeHead(400, {'content-type': 'application/json'})
                    res.end(JSON.stringify({error: {code: 400, message: state.fail, type: 'invalid_request_error'}}))
                    return
                }
                const parsed = JSON.parse(body || '{}')
                if (!parsed.model) {
                    res.writeHead(400, {'content-type': 'application/json'})
                    res.end(JSON.stringify({error: {code: 400, message: 'model is not found'}}))
                    return
                }
                unloaded.push(parsed.model)
                res.writeHead(200, {'content-type': 'application/json'})
                res.end(JSON.stringify({success: true}))
                return
            }

            res.writeHead(404, {'content-type': 'application/json'})
            res.end('{}')
        })
    })

    server = {
        unloaded,
        get fail() {
            return state.fail
        },
        set fail(v: string | undefined) {
            state.fail = v
        },
        url: '',
        close: () => new Promise<void>((resolve) => handle.close(() => resolve())),
    }

    return new Promise((resolve, reject) => {
        handle.once('error', reject)
        handle.listen(0, '127.0.0.1', () => {
            const address = handle.address()
            if (address === null || typeof address === 'string') {
                reject(new Error('bind failed'))
                return
            }
            server!.url = `http://127.0.0.1:${address.port}`
            resolve(server!.url)
        })
    })
}

describe('parseUnloadTarget', () => {
    it('reads the model id after the command name', () => {
        expect(parseUnloadTarget('/llamacpp-unload my-model')).toBe('my-model')
    })

    it('works when the host has already stripped the command name', () => {
        expect(parseUnloadTarget('my-model')).toBe('my-model')
    })

    it('returns undefined for a bare command', () => {
        expect(parseUnloadTarget('/llamacpp-unload')).toBeUndefined()
        expect(parseUnloadTarget('/llamacpp-unload   ')).toBeUndefined()
    })

    it('returns undefined for empty input', () => {
        expect(parseUnloadTarget(undefined)).toBeUndefined()
        expect(parseUnloadTarget('')).toBeUndefined()
    })

    it('is case insensitive on the command name', () => {
        expect(parseUnloadTarget('/LLaMaCpp-Unload foo')).toBe('foo')
    })

    it('keeps spaces inside a model id', () => {
        expect(parseUnloadTarget('my model')).toBe('my model')
    })
})

describe('resolveTarget', () => {
    const models = [{id: 'alpha-7b'}, {id: 'beta-13b'}, {id: 'gamma'}]

    it('matches exactly', () => {
        expect(resolveTarget('beta-13b', models)).toEqual({found: true, id: 'beta-13b'})
    })

    it('matches case insensitively', () => {
        expect(resolveTarget('BETA-13B', models)).toEqual({found: true, id: 'beta-13b'})
    })

    it('matches a unique substring', () => {
        expect(resolveTarget('gamma', models)).toEqual({found: true, id: 'gamma'})
    })

    it('reports ambiguity rather than guessing', () => {
        // Guessing here could unload the wrong model and lose VRAM state.
        const result = resolveTarget('b', [{id: 'beta'}, {id: 'beta-2'}])
        expect(result.found).toBe(false)
        if (!result.found) expect(result.reason).toBe('ambiguous')
    })

    it('reports unknown when nothing matches', () => {
        const result = resolveTarget('zzz', models)
        expect(result.found).toBe(false)
        if (!result.found) expect(result.reason).toBe('unknown')
    })
})

describe('performUnload', () => {
    beforeEach(() => {
        setLlamaBaseURL(null)
        setLlamaModels([])
        setActiveModel('')
    })

    afterEach(async () => {
        await server?.close()
        server = null
    })

    it('lists loaded models when given no argument', async () => {
        const url = await startServer()
        setLlamaBaseURL(url)
        setLlamaModels([model('a', 'loaded'), model('b', 'unloaded'), model('c', 'loaded')])

        const outcome = await performUnload(undefined)
        expect(outcome).toEqual({kind: 'listed', loaded: ['a', 'c']})
    })

    it('unloads a resident model', async () => {
        const url = await startServer()
        setLlamaBaseURL(url)
        setLlamaModels([model('a', 'loaded')])

        const outcome = await performUnload('a')

        expect(outcome).toEqual({kind: 'unloaded', model: 'a'})
        expect(server!.unloaded).toEqual(['a'])
    })

    it('refuses to unload the model carrying the current request', async () => {
        const url = await startServer()
        setLlamaBaseURL(url)
        setLlamaModels([model('a', 'loaded')])
        setActiveModel('a')

        const outcome = await performUnload('a')

        expect(outcome).toEqual({kind: 'refused-active', model: 'a'})
        // Nothing sent: unloading mid-request strands the request.
        expect(server!.unloaded).toEqual([])
    })

    it('does not spend a round trip on an already-cold model', async () => {
        const url = await startServer()
        setLlamaBaseURL(url)
        setLlamaModels([model('a', 'unloaded')])

        const outcome = await performUnload('a')

        expect(outcome).toEqual({kind: 'not-loaded', model: 'a'})
        expect(server!.unloaded).toEqual([])
    })

    it('reports an unknown model without calling the server', async () => {
        const url = await startServer()
        setLlamaBaseURL(url)
        setLlamaModels([model('a', 'loaded')])

        const outcome = await performUnload('nope')

        expect(outcome).toEqual({kind: 'unknown-model', requested: 'nope'})
        expect(server!.unloaded).toEqual([])
    })

    it('surfaces the server error message', async () => {
        const url = await startServer()
        server!.fail = 'model is busy'
        setLlamaBaseURL(url)
        setLlamaModels([model('a', 'loaded')])

        const outcome = await performUnload('a')

        expect(outcome).toEqual({kind: 'failed', model: 'a', error: 'model is busy'})
    })

    it('reports no-server when nothing is configured', async () => {
        expect(await performUnload('a')).toEqual({kind: 'no-server'})
    })

    it('reports no-server when asked to list without a server', async () => {
        expect(await performUnload(undefined)).toEqual({kind: 'no-server'})
    })
})

describe('describeUnload', () => {
    it('confirms an unload', () => {
        expect(describeUnload({kind: 'unloaded', model: 'a'})).toMatch(/unloaded a/i)
    })

    it('says nothing is loaded when the list is empty', () => {
        expect(describeUnload({kind: 'listed', loaded: []})).toMatch(/nothing is currently loaded/i)
    })

    it('lists the loaded models', () => {
        expect(describeUnload({kind: 'listed', loaded: ['a', 'b']})).toContain('a, b')
    })

    it('explains why it refused the active model', () => {
        const text = describeUnload({kind: 'refused-active', model: 'a'})
        expect(text).toMatch(/refusing/i)
        expect(text).toMatch(/current request/i)
        expect(text).toMatch(/switch models/i)
    })

    it('reports an already-cold model without implying failure', () => {
        expect(describeUnload({kind: 'not-loaded', model: 'a'})).toMatch(/already unloaded/i)
    })

    it('includes the server error verbatim', () => {
        expect(describeUnload({kind: 'failed', model: 'a', error: 'model is busy'})).toContain('model is busy')
    })

    it('offers a next step for an unknown model', () => {
        const text = describeUnload({kind: 'unknown-model', requested: 'zzz'})
        expect(text).toContain('zzz')
        expect(text).toMatch(/llamacpp-unload/i)
    })

    it('lists candidates when ambiguous', () => {
        const text = describeUnload({kind: 'ambiguous', requested: 'b', candidates: ['beta', 'beta-2']})
        expect(text).toContain('beta-2')
    })
})

describe('createUnloadCommand', () => {
    beforeEach(() => {
        setLlamaBaseURL(null)
        setLlamaModels([])
        setActiveModel('')
    })

    it('registers and can be disposed', async () => {
        const commands: any[] = []
        let disposed = false
        const ctx = {
            command: {
                transform: async (cb: any) => {
                    cb({add: (d: any) => commands.push(d)})
                    return {dispose: async () => {
                        disposed = true
                    }}
                },
            },
        } as any

        const cleanup = await createUnloadCommand(ctx)

        expect(commands).toHaveLength(1)
        expect(commands[0].name).toBe('llamacpp-unload')

        await cleanup?.()
        expect(disposed).toBe(true)
    })

    it('does not break startup without a command domain', async () => {
        await expect(createUnloadCommand({} as any)).resolves.toBeUndefined()
    })
})