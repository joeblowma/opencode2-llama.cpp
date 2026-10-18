import {describe, expect, it} from 'vitest'
import {readFileSync} from 'fs'
import {dirname, join} from 'path'
import {fileURLToPath} from 'url'
import {resolveContextSize} from '../src/utils/resolve-context-size'
import {isReady, parseLoadState} from '../src/utils/model-load-state'
import type {LlamaCppModel} from '../src/types'

/**
 * Regression tests against a payload captured from a real `llama-server`.
 *
 * Fixture provenance and regeneration notes: `fixtures/README.md`.
 *
 * The point is to pin the *shape*, not just the behaviour: this response has no
 * top-level `context_length`, hides `--ctx-size` inside a ~97-token argv, and
 * omits `meta` entirely on unloaded models. A future llama.cpp release that
 * renames any of these should fail here rather than quietly reporting a wrong
 * context size to the catalog.
 */
const fixture = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'llama-server-models.json'), 'utf-8'),
) as LlamaCppModel[]

const byId = (id: string) => fixture.find((m) => m.id === id)!

describe('llama-server /v1/models fixture', () => {
    it('parses as the expected response shape', () => {
        expect(Array.isArray(fixture)).toBe(true)
        expect(fixture.length).toBeGreaterThan(0)
        for (const m of fixture) {
            expect(typeof m.id).toBe('string')
            expect(m.object).toBe('model')
            expect(m.owned_by).toBe('llamacpp')
            expect(typeof m.created).toBe('number')
        }
    })

    it('carries NO top-level context field on any model', () => {
        // The reason `resolveContextSize` must dig into `status.args` at all.
        for (const m of fixture) {
            expect(m.context_length).toBeUndefined()
            expect(m.context_window).toBeUndefined()
        }
    })

    it('carries NO meta block on unloaded models', () => {
        for (const m of fixture.filter((x) => parseLoadState(x.status?.value) !== 'loaded')) {
            expect(m.meta).toBeUndefined()
        }
    })

    it('does expose meta once loaded', () => {
        const loaded = fixture.find((m) => parseLoadState(m.status?.value) === 'loaded')
        expect(loaded).toBeDefined()
        expect(loaded!.meta?.n_ctx).toBeGreaterThan(0)
    })

    it('carries a non-trivial argv on every unloaded model', () => {
        for (const m of fixture.filter((x) => parseLoadState(x.status?.value) !== 'loaded')) {
            expect(Array.isArray(m.status?.args)).toBe(true)
            expect(m.status!.args!.length).toBeGreaterThan(10)
        }
    })
})

describe('resolveContextSize against the real payload', () => {
    it('reads 98304 out of argv for an unloaded model', () => {
        expect(resolveContextSize(byId('Qwopus3-5-9B-Coder-Flash'))).toBe(98304)
    })

    it('reads 98304 for a multimodal model', () => {
        expect(resolveContextSize(byId('Qwopus3.5-9B-v3.5.coder_MM_V3'))).toBe(98304)
    })

    it('reads 131072 for a text+image+audio model', () => {
        expect(resolveContextSize(byId('gemma-4-E4B-MTP'))).toBe(131072)
    })

    it('agrees between argv and meta for a loaded model', () => {
        // Cross-check: if these ever diverge, one source has become stale.
        const m = byId('JackOD-9B-Coder-MTP-v4')
        expect(resolveContextSize(m)).toBe(65536)
        expect(m.meta!.n_ctx).toBe(65536)
    })

    it('resolves every model in the fixture', () => {
        // No model should ever fall back on a server this well configured.
        for (const m of fixture) {
            expect(resolveContextSize(m), `no context for ${m.id}`).toBeGreaterThan(0)
        }
    })

    it('never returns the SDK default of 200000', () => {
        for (const m of fixture) {
            expect(resolveContextSize(m)).not.toBe(200_000)
        }
    })

    it('never reports a trained context in place of the serving context', () => {
        // n_ctx_train is the model maximum and can exceed what is served; the
        // plugin must advertise the serving context, not the trained one.
        const m = byId('JackOD-9B-Coder-MTP-v4')
        expect(resolveContextSize(m)).toBe(m.meta!.n_ctx)
    })
})

describe('load state against the real payload', () => {
    it('marks the loaded model ready', () => {
        expect(isReady(byId('JackOD-9B-Coder-MTP-v4'))).toBe(true)
    })

    it('marks every unloaded model not ready', () => {
        for (const m of fixture.filter((x) => x.id !== 'JackOD-9B-Coder-MTP-v4')) {
            expect(isReady(m), `${m.id} should not be ready`).toBe(false)
        }
    })

    it('reports only documented status values', () => {
        for (const m of fixture) {
            expect(['loaded', 'loading', 'unloaded']).toContain(m.status?.value)
        }
    })
})

describe('modality metadata', () => {
    it('reads text-only for a plain model', () => {
        expect(byId('Qwopus3-5-9B-Coder-Flash').architecture?.input_modalities).toEqual(['text'])
    })

    it('reads vision for an mmproj model', () => {
        expect(byId('Qwopus3.5-9B-v3.5.coder_MM_V3').architecture?.input_modalities).toEqual(['text', 'image'])
    })

    it('reads audio support, which no heuristic could infer', () => {
        // Only the GGUF metadata knows this; a name-based guess would say text.
        expect(byId('gemma-4-E4B-MTP').architecture?.input_modalities).toEqual(['text', 'image', 'audio'])
    })

    it('reports text as the output modality throughout', () => {
        for (const m of fixture) {
            expect(m.architecture?.output_modalities).toEqual(['text'])
        }
    })
})