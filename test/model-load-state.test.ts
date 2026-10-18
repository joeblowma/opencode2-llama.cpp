import {describe, expect, it} from 'vitest'
import {describeColdModel, isReady, parseLoadState} from '../src/utils/model-load-state'
import type {LlamaCppModel} from '../src/types'

const model = (status?: string): LlamaCppModel => ({
    id: 'test-model',
    object: 'model',
    created: 0,
    owned_by: 'llamacpp',
    ...(status === undefined ? {} : {status: {value: status}}),
})

describe('parseLoadState', () => {
    it('recognises loaded', () => {
        expect(parseLoadState('loaded')).toBe('loaded')
    })

    it('recognises loading', () => {
        expect(parseLoadState('loading')).toBe('loading')
    })

    it('recognises unloaded', () => {
        expect(parseLoadState('unloaded')).toBe('unloaded')
    })

    it('is case and whitespace insensitive', () => {
        expect(parseLoadState('  LOADED ')).toBe('loaded')
        expect(parseLoadState('Loading')).toBe('loading')
    })

    it('treats an unknown value as cold rather than ready', () => {
        // Assuming "ready" is what produces a silent multi-minute stall, so an
        // unrecognised state must fail safe.
        expect(parseLoadState('sleeping')).toBe('unloaded')
        expect(parseLoadState('')).toBe('unloaded')
        expect(parseLoadState(undefined)).toBe('unloaded')
    })
})

describe('isReady', () => {
    it('is true only for loaded', () => {
        expect(isReady(model('loaded'))).toBe(true)
    })

    it('is false while loading', () => {
        expect(isReady(model('loading'))).toBe(false)
    })

    it('is false when unloaded or absent', () => {
        expect(isReady(model('unloaded'))).toBe(false)
        expect(isReady(model())).toBe(false)
    })
})

describe('describeColdModel', () => {
    it('distinguishes a load already in progress', () => {
        const text = describeColdModel(model('loading'))
        expect(text).toContain('currently loading')
        expect(text).toContain('test-model')
        expect(text).toMatch(/wait/i)
    })

    it('explains that a cold model must load first', () => {
        const text = describeColdModel(model('unloaded'))
        expect(text).toContain('not loaded')
        expect(text).toContain('test-model')
        expect(text).toMatch(/trigger a model load/i)
    })

    it('gives different advice for loading vs unloaded', () => {
        // The remedy differs: one is underway, the other has not started.
        expect(describeColdModel(model('loading'))).not.toBe(describeColdModel(model('unloaded')))
    })

    it('names the model so the warning is actionable', () => {
        const m = {...model('unloaded'), id: 'Qwopus3.5-9B-v3.5.coder_MM_V3'}
        expect(describeColdModel(m)).toContain('Qwopus3.5-9B-v3.5.coder_MM_V3')
    })

    it('stays concise enough for a system prompt', () => {
        expect(describeColdModel(model('unloaded')).length).toBeLessThan(400)
    })
})