import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createServer} from 'http'
import {createRpcBridge, refreshVariant, unloadVariant} from '../src/plugin/rpc-bridge'
import {createRefreshCommand} from '../src/plugin/refresh-command'
import {createUnloadCommand} from '../src/plugin/unload-command'
import tuiPlugin from '../src/tui'
import {
    setActiveModel,
    setLlamaBaseURL,
    setLlamaModels,
} from '../src/plugin/llama-state'
import type {LlamaCppModel} from '../src/types'

/** A router-mode stand-in that accepts `POST /models/unload`. */
async function startUnloadServer(): Promise<{url: string; close: () => Promise<void>}> {
    const handle = createServer((req, res) => {
        let body = ''
        req.on('data', (c) => body += c)
        req.on('end', () => {
            if (req.method === 'POST' && (req.url ?? '').startsWith('/models/unload')) {
                const parsed = JSON.parse(body || '{}')
                if (!parsed.model) {
                    res.writeHead(400, {'content-type': 'application/json'})
                    res.end(JSON.stringify({error: {code: 400, message: 'model is not found'}}))
                    return
                }
                res.writeHead(200, {'content-type': 'application/json'})
                res.end(JSON.stringify({success: true}))
                return
            }
            res.writeHead(404, {'content-type': 'application/json'})
            res.end('{}')
        })
    })

    return new Promise((resolve) => {
        handle.listen(0, '127.0.0.1', () => {
            const address = handle.address() as {port: number}
            resolve({
                url: `http://127.0.0.1:${address.port}`,
                close: () => new Promise<void>((done) => handle.close(() => done())),
            })
        })
    })
}

/**
 * Covers the server↔TUI boundary.
 *
 * These two plugins run in separate processes, so the risk is not that either
 * half is wrong in isolation but that they disagree about the wire format. The
 * fakes below are deliberately thin: they only implement the two surfaces that
 * meet — `rpc.register` / `events.emit` on one side, `client.rpc().events.on`
 * and `ui.toast` on the other — so a signature change breaks here rather than
 * silently at runtime.
 */

const model = (id: string, status: string): LlamaCppModel => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'llamacpp',
    status: {value: status},
})

/** Wires a fake server process to a fake TUI process over a shared event bus. */
function createPair() {
    const toasts: any[] = []
    const commands: any[] = []
    const listeners: ((payload: any) => void)[] = []
    const handlers: Record<string, (input: any) => Promise<any>> = {}
    const registrations: any[] = []

    const ctx: any = {
        options: {},
        provider: {
            list: async () => ({location: {}, data: []}),
            transform: async () => ({dispose: async () => {}}),
            reload: async () => {},
        },
        event: {subscribe: async function* () { return }},
        command: {
            transform: async (cb: any) => {
                cb({add: (d: any) => commands.push(d)})
                const reg = {dispose: vi.fn()}
                registrations.push(reg)
                return reg
            },
        },
        rpc: {
            register: async (_def: any, h: any) => {
                Object.assign(handlers, h)
                return {
                    dispose: async () => {},
                    events: {
                        emit: async (name: string, data: any) => {
                            for (const l of listeners) l({type: `rpc.${name}`, data})
                        },
                    },
                }
            },
        },
    }

    const tuiCtx: any = {
        client: {
            rpc: () => ({
                events: {
                    on: (_name: string, handler: any) => {
                        listeners.push(handler)
                        return () => {
                            const i = listeners.indexOf(handler)
                            if (i !== -1) listeners.splice(i, 1)
                        }
                    },
                },
            }),
        },
        ui: {toast: {show: (o: any) => toasts.push(o)}},
    }

    return {ctx, tuiCtx, toasts, commands, listeners, handlers, registrations}
}

/**
 * A port nothing is listening on.
 *
 * Tests must not depend on "no llama.cpp running" to reach a given outcome:
 * `resolveBaseURL` falls back to scanning the default ports, so on a developer
 * machine that finds a real server and returns `changed`. Pointing at a closed
 * port makes the outcome deterministically `unreachable`.
 */
const DEAD_URL = 'http://127.0.0.1:1'

describe('server ↔ TUI bridge', () => {
    let originalUserProfile: string | undefined
    let originalHome: string | undefined

    beforeEach(() => {
        originalUserProfile = process.env.USERPROFILE
        originalHome = process.env.HOME
        process.env.USERPROFILE = '/nonexistent-home'
        process.env.HOME = '/nonexistent-home'
        setLlamaBaseURL(DEAD_URL)
        setLlamaModels([])
        setActiveModel('')
    })

    afterEach(() => {
        process.env.USERPROFILE = originalUserProfile
        process.env.HOME = originalHome
    })

    it('shows a toast when the refresh command runs', async () => {
        const pair = createPair()

        const bridge = await createRpcBridge(pair.ctx)
        await createRefreshCommand(pair.ctx, bridge)
        await tuiPlugin.setup(pair.tuiCtx)

        pair.toasts.length = 0
        await pair.commands[0].execute({sessionID: 'ses_x', prompt: {}})

        expect(pair.toasts).toHaveLength(1)
        expect(pair.toasts[0].title).toBe('llama.cpp')
        expect(pair.toasts[0].message).toBeTruthy()

        await bridge.dispose()
    })

    it('labels the toast by severity', async () => {
        const pair = createPair()

        const bridge = await createRpcBridge(pair.ctx)
        await createRefreshCommand(pair.ctx, bridge)
        await tuiPlugin.setup(pair.tuiCtx)

        pair.toasts.length = 0
        await pair.commands[0].execute({sessionID: 'ses_x', prompt: {}})

        // Unreachable server is a warning, not a success.
        expect(pair.toasts[0].variant).toBe('warning')

        await bridge.dispose()
    })

    it('sends the server wording verbatim, with no duplicated prefix', async () => {
        const pair = createPair()

        const bridge = await createRpcBridge(pair.ctx)
        await createRefreshCommand(pair.ctx, bridge)
        await tuiPlugin.setup(pair.tuiCtx)

        pair.toasts.length = 0
        await pair.commands[0].execute({sessionID: 'ses_x', prompt: {}})

        const {title, message} = pair.toasts[0]
        // The title already says llama.cpp; the message must not repeat it.
        expect(message.toLowerCase().startsWith('llama.cpp')).toBe(false)
        expect(`${title}: ${message}`.toLowerCase().includes('llama.cpp: llama.cpp')).toBe(false)

        await bridge.dispose()
    })

    it('exposes refresh and unload as callable RPC methods', async () => {
        const pair = createPair()

        const bridge = await createRpcBridge(pair.ctx)

        const refreshed = await pair.handlers.refresh({})
        expect(refreshed.text).toMatch(/not answering/i)

        // With an empty catalog there is nothing to resolve against, so the correct
        // answer is "unknown model" — not a server error.
        const unloaded = await pair.handlers.unload({model: 'anything'})
        expect(unloaded.text).toMatch(/no model matches/i)
        expect(unloaded.variant).toBe('warning')

        await bridge.dispose()
    })

    it('uses the same wording for the command and the RPC method', async () => {
        const pair = createPair()

        const bridge = await createRpcBridge(pair.ctx)
        await createRefreshCommand(pair.ctx, bridge)
        await tuiPlugin.setup(pair.tuiCtx)

        await pair.commands[0].execute({sessionID: 'ses_x', prompt: {}})
        const viaCommand = pair.toasts.at(-1)!.message

        const viaRpc = await pair.handlers.refresh({})

        expect(viaRpc.text).toBe(viaCommand)

        await bridge.dispose()
    })

    it('toasts unload results too', async () => {
        // A live stub server, so the unload path reaches a real model name.
        const server = await startUnloadServer()
        setLlamaBaseURL(server.url)
        setLlamaModels([{id: 'some-model', object: 'model', created: 0, owned_by: 'llamacpp', status: {value: 'unloaded'}}])

        const pair = createPair()

        const bridge = await createRpcBridge(pair.ctx)
        await createUnloadCommand(pair.ctx, bridge)
        await tuiPlugin.setup(pair.tuiCtx)

        pair.toasts.length = 0
        await pair.commands[0].execute({sessionID: 'ses_x', prompt: {text: '/llamacpp-unload some-model'}})

        expect(pair.toasts).toHaveLength(1)
        expect(pair.toasts[0].message).toContain('some-model')

        await bridge.dispose()
        await server.close()
    })

    it('still runs the command when no TUI is listening', async () => {
        setLlamaBaseURL(null)
        const pair = createPair()

        // No TUI setup at all: nothing subscribed.
        const bridge = await createRpcBridge(pair.ctx)
        await createRefreshCommand(pair.ctx, bridge)

        await expect(pair.commands[0].execute({sessionID: 'ses_x', prompt: {}})).resolves.toBeUndefined()

        await bridge.dispose()
    })

    it('unsubscribes from events when the TUI plugin is disposed', async () => {
        setLlamaBaseURL(null)
        const pair = createPair()

        const bridge = await createRpcBridge(pair.ctx)
        await createRefreshCommand(pair.ctx, bridge)

        const cleanup = await tuiPlugin.setup(pair.tuiCtx)
        expect(pair.listeners).toHaveLength(1)

        await (cleanup as () => Promise<void>)()
        expect(pair.listeners).toHaveLength(0)

        await bridge.dispose()
    })

    it('does not emit after the bridge is disposed', async () => {
        setLlamaBaseURL(null)
        const pair = createPair()

        const bridge = await createRpcBridge(pair.ctx)
        await createRefreshCommand(pair.ctx, bridge)
        await tuiPlugin.setup(pair.tuiCtx)

        await bridge.dispose()

        pair.toasts.length = 0
        // Must not throw even though the registration is gone.
        await expect(pair.commands[0].execute({sessionID: 'ses_x', prompt: {}})).resolves.toBeUndefined()
    })

    it('ignores a malformed notification instead of showing an empty toast', async () => {
        const pair = createPair()
        await tuiPlugin.setup(pair.tuiCtx)

        pair.toasts.length = 0
        for (const l of pair.listeners) {
            l({type: 'rpc.notified', data: undefined})
            l({type: 'rpc.notified', data: {text: ''}})
        }

        expect(pair.toasts).toHaveLength(0)
    })
})

describe('variant mapping', () => {
    it('treats a successful refresh as info', () => {
        expect(refreshVariant('changed')).toBe('info')
        expect(refreshVariant('unchanged')).toBe('info')
    })

    it('treats a failed refresh as a warning', () => {
        expect(refreshVariant('unreachable')).toBe('warning')
        expect(refreshVariant('no-server')).toBe('warning')
    })

    it('treats an informational unload as info', () => {
        expect(unloadVariant('unloaded')).toBe('info')
        expect(unloadVariant('listed')).toBe('info')
        expect(unloadVariant('not-loaded')).toBe('info')
    })

    it('treats a problematic unload as a warning', () => {
        expect(unloadVariant('unknown-model')).toBe('warning')
        expect(unloadVariant('refused-active')).toBe('warning')
        expect(unloadVariant('failed')).toBe('warning')
        expect(unloadVariant('ambiguous')).toBe('warning')
    })
})

describe('model fixtures used by the unload path', () => {
    it('builds a well-formed model', () => {
        expect(model('a', 'loaded')).toMatchObject({id: 'a', status: {value: 'loaded'}})
    })
})