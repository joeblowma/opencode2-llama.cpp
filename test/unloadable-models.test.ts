import {describe, expect, it} from 'vitest'
import {existsSync} from 'fs'
import {extractModelPath, findUnloadableModels, isUnloadable} from '../src/utils/unloadable-models'
import type {LlamaCppModel} from '../src/types'

const model = (id: string, args?: string[]): LlamaCppModel => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'llamacpp',
    ...(args ? {status: {value: 'unloaded', args}} : {}),
})

/** A path that definitely does not exist, used as a missing weights file. */
const MISSING = 'C:\\definitely\\not\\here\\model.gguf'
/** This very file, which definitely does exist. */
const PRESENT = __filename

describe('extractModelPath', () => {
    it('reads --model from argv', () => {
        expect(extractModelPath(model('m', ['llama-server.exe', '--model', 'x.gguf']))).toBe('x.gguf')
    })

    it('returns undefined when there is no argv', () => {
        expect(extractModelPath(model('m'))).toBeUndefined()
    })

    it('returns undefined when --model is absent', () => {
        expect(extractModelPath(model('m', ['llama-server.exe', '--ctx-size', '8192']))).toBeUndefined()
    })

    it('returns undefined when --model has no value', () => {
        expect(extractModelPath(model('m', ['--model']))).toBeUndefined()
    })

    it('handles a trailing --model with no value', () => {
        expect(extractModelPath(model('m', ['llama-server.exe', '--ctx-size', '1', '--model']))).toBeUndefined()
    })
})

describe('isUnloadable', () => {
    it('flags a model whose weights are missing', async () => {
        const m = model('broken', ['llama-server.exe', '--model', MISSING])
        const result = await isUnloadable(m)
        expect(result).not.toBeNull()
        expect(result!.model.id).toBe('broken')
        expect(result!.modelPath).toBe(MISSING)
    })

    it('does not flag a model whose weights exist', async () => {
        const m = model('fine', ['llama-server.exe', '--model', PRESENT])
        expect(await isUnloadable(m)).toBeNull()
    })

    it('leaves an unverifiable model alone rather than hiding it', async () => {
        // No argv at all: nothing to check, so it must survive.
        expect(await isUnloadable(model('unknown'))).toBeNull()
    })

    it('leaves a remote weights URL alone', async () => {
        const m = model('remote', ['llama-server.exe', '--model', 'https://example.com/m.gguf'])
        expect(await isUnloadable(m)).toBeNull()
    })

    it('accepts a windows path', async () => {
        const m = model('win', ['llama-server.exe', '--model', MISSING])
        expect(await isUnloadable(m)).not.toBeNull()
    })

    it('accepts a posix path', async () => {
        const m = model('posix', ['llama-server.exe', '--model', '/nonexistent/model.gguf'])
        expect(await isUnloadable(m)).not.toBeNull()
    })

    it('accepts a file: URL', async () => {
        const m = model('url', ['llama-server.exe', '--model', 'file:///nonexistent/m.gguf'])
        expect(await isUnloadable(m)).not.toBeNull()
    })
})

describe('findUnloadableModels', () => {
    it('separates loadable from unloadable', async () => {
        const {loadable, unloadable} = await findUnloadableModels([
            model('good', ['--model', PRESENT]),
            model('bad', ['--model', MISSING]),
            model('unsure'),
        ])

        expect(loadable.map((m) => m.id)).toEqual(['good', 'unsure'])
        expect(unloadable.map((u) => u.model.id)).toEqual(['bad'])
    })

    it('reports the offending path for each unloadable model', async () => {
        const {unloadable} = await findUnloadableModels([model('bad', ['--model', MISSING])])
        expect(unloadable[0].modelPath).toBe(MISSING)
    })

    it('keeps everything when nothing is broken', async () => {
        const input = [model('a', ['--model', PRESENT]), model('b', ['--model', PRESENT])]
        const {loadable, unloadable} = await findUnloadableModels(input)
        expect(loadable).toHaveLength(2)
        expect(unloadable).toHaveLength(0)
    })

    it('never throws on a mixed batch', async () => {
        await expect(findUnloadableModels([
            model('a', ['--model', MISSING]),
            model('b'),
            model('c', ['--model', 'https://x/y.gguf']),
        ])).resolves.toBeDefined()
    })

    it('handles an empty list', async () => {
        const {loadable, unloadable} = await findUnloadableModels([])
        expect(loadable).toEqual([])
        expect(unloadable).toEqual([])
    })

    it('agrees with a direct fs check', async () => {
        const {loadable, unloadable} = await findUnloadableModels([model('bad', ['--model', MISSING])])
        expect(existsSync(MISSING)).toBe(false)
        expect(loadable).toHaveLength(0)
        expect(unloadable).toHaveLength(1)
    })
})