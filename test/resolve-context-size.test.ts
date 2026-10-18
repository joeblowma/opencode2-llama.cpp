import {describe, expect, it} from 'vitest'
import {FALLBACK_CONTEXT_SIZE, resolveContextSize} from '../src/utils/resolve-context-size'
import type {LlamaCppModel} from '../src/types'

/** Minimal model fixture; only the fields under test are set. */
const model = (over: Partial<LlamaCppModel>): LlamaCppModel => ({
    id: 'test',
    object: 'model',
    created: 0,
    owned_by: 'llamacpp',
    ...over,
})

describe('resolveContextSize', () => {
    it('prefers context_length', () => {
        expect(resolveContextSize(model({context_length: 65536}))).toBe(65536)
    })

    it('falls back to context_window', () => {
        expect(resolveContextSize(model({context_window: 32768}))).toBe(32768)
    })

    it('reads --ctx-size from launch args for unloaded models', () => {
        const m = model({
            status: {value: 'unloaded', args: ['llama-server.exe', '--model', 'x.gguf', '--ctx-size', '131072']},
        })
        expect(resolveContextSize(m)).toBe(131072)
    })

    it('reads the short -c spelling', () => {
        const m = model({status: {args: ['llama-server.exe', '-c', '8192']}})
        expect(resolveContextSize(m)).toBe(8192)
    })

    it('prefers the long spelling when both are present', () => {
        const m = model({status: {args: ['-c', '111', '--ctx-size', '222']}})
        expect(resolveContextSize(m)).toBe(222)
    })

    it('returns undefined when there is no status at all', () => {
        expect(resolveContextSize(model({}))).toBeUndefined()
    })

    it('returns undefined when args carry no context flag', () => {
        const m = model({status: {args: ['llama-server.exe', '--model', 'x.gguf']}})
        expect(resolveContextSize(m)).toBeUndefined()
    })

    it('ignores a non-numeric or non-positive ctx value', () => {
        expect(resolveContextSize(model({status: {args: ['--ctx-size', 'abc']}}))).toBeUndefined()
        expect(resolveContextSize(model({status: {args: ['--ctx-size', '0']}}))).toBeUndefined()
        expect(resolveContextSize(model({status: {args: ['--ctx-size', '-1']}}))).toBeUndefined()
    })

    it('does not treat a flag value that merely looks like a flag as a match', () => {
        // `--model` followed by a value; ensure we never read a non-adjacent token.
        const m = model({status: {args: ['--model', '--ctx-size']}})
        expect(resolveContextSize(m)).toBeUndefined()
    })

    it('handles a real llama-server args array', () => {
        const m = model({
            status: {
                args: [
                    'llama-server.exe', '--cache-reuse', '256', '--context-shift',
                    '--host', '127.0.0.1', '--port', '0', '--batch-size', '2048',
                    '--ctx-size', '98304', '--model', 'C:\\models\\x.gguf',
                ],
            },
        })
        expect(resolveContextSize(m)).toBe(98304)
    })
})

describe('FALLBACK_CONTEXT_SIZE', () => {
    it('is far below the SDK default of 200000', () => {
        expect(FALLBACK_CONTEXT_SIZE).toBeLessThan(200_000)
    })

    it('is well below any plausible local server context', () => {
        // Real llama.cpp deployments run 32k-131k; the fallback must not
        // over-report against them.
        expect(FALLBACK_CONTEXT_SIZE).toBeLessThanOrEqual(32_768)
    })

    it('is large enough to be usable', () => {
        expect(FALLBACK_CONTEXT_SIZE).toBeGreaterThanOrEqual(4_096)
    })

    it('is a power-of-two multiple, as context sizes conventionally are', () => {
        expect(FALLBACK_CONTEXT_SIZE % 1024).toBe(0)
    })
})