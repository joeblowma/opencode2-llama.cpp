import {afterEach, describe, expect, it} from 'vitest'
import {FALLBACK_CONTEXT_SIZE} from '../src/utils/resolve-context-size'
import {getFallbackContext, setFallbackContext} from '../src/plugin/llama-state'

describe('fallbackContext', () => {
    // The snapshot is module-level and shared; restore the default so ordering
    // between tests cannot leak state.
    afterEach(() => setFallbackContext(FALLBACK_CONTEXT_SIZE))

    it('defaults to the conservative built-in value', () => {
        expect(getFallbackContext()).toBe(FALLBACK_CONTEXT_SIZE)
    })

    it('accepts a larger override for big-VRAM hardware', () => {
        setFallbackContext(131_072)
        expect(getFallbackContext()).toBe(131_072)
    })

    it('accepts 32k as a moderate override', () => {
        setFallbackContext(32_768)
        expect(getFallbackContext()).toBe(32_768)
    })

    it('rejects values below the usable floor and keeps the default', () => {
        setFallbackContext(1024)
        expect(getFallbackContext()).toBe(FALLBACK_CONTEXT_SIZE)
    })

    it('rejects zero rather than producing an unusable model', () => {
        setFallbackContext(0)
        expect(getFallbackContext()).toBe(FALLBACK_CONTEXT_SIZE)
    })

    it('rejects negative values', () => {
        setFallbackContext(-4096)
        expect(getFallbackContext()).toBe(FALLBACK_CONTEXT_SIZE)
    })

    it('rejects non-finite values', () => {
        setFallbackContext(Number.NaN)
        expect(getFallbackContext()).toBe(FALLBACK_CONTEXT_SIZE)

        setFallbackContext(Number.POSITIVE_INFINITY)
        expect(getFallbackContext()).toBe(FALLBACK_CONTEXT_SIZE)
    })

    it('floors fractional values to a whole number of tokens', () => {
        setFallbackContext(32_768.7)
        expect(getFallbackContext()).toBe(32_768)
    })

    it('accepts exactly the floor', () => {
        setFallbackContext(4_096)
        expect(getFallbackContext()).toBe(4_096)
    })
})