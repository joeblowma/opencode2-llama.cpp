import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
    normalizeBaseURL,
    buildAPIURL,
    checkLlamaCppHealth,
    discoverLlamaCppModels,
    fetchLlamaCppModelsDirect,
    autoDetectLlamaCpp,
} from '../src/utils/llama-cpp-api'

const mockFetch = vi.fn()
global.fetch = mockFetch

beforeEach(() => {
    mockFetch.mockReset()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('normalizeBaseURL', () => {
    it('should return default URL when called with no arguments', () => {
        expect(normalizeBaseURL()).toBe('http://127.0.0.1:1234')
    })

    it('should remove trailing slash', () => {
        expect(normalizeBaseURL('http://localhost:1234/')).toBe('http://localhost:1234')
        expect(normalizeBaseURL('http://localhost:1234///')).toBe('http://localhost:1234')
    })

    it('should remove /v1 suffix', () => {
        expect(normalizeBaseURL('http://localhost:1234/v1')).toBe('http://localhost:1234')
    })

    it('should remove trailing slash and /v1 suffix', () => {
        expect(normalizeBaseURL('http://localhost:1234/v1/')).toBe('http://localhost:1234')
    })

    it('should not alter a clean URL', () => {
        expect(normalizeBaseURL('http://localhost:1234')).toBe('http://localhost:1234')
    })
})

describe('buildAPIURL', () => {
    it('should build URL with default endpoint', () => {
        expect(buildAPIURL('http://localhost:1234')).toBe('http://localhost:1234/v1/models')
    })

    it('should normalize baseURL before building', () => {
        expect(buildAPIURL('http://localhost:1234/v1')).toBe('http://localhost:1234/v1/models')
    })

    it('should build URL with custom endpoint', () => {
        expect(buildAPIURL('http://localhost:1234', '/v1/chat/completions')).toBe(
            'http://localhost:1234/v1/chat/completions'
        )
    })
})

describe('checkLlamaCppHealth', () => {
    it('should return true when server responds ok', async () => {
        mockFetch.mockResolvedValue({ok: true})
        const result = await checkLlamaCppHealth('http://localhost:1234')
        expect(result).toBe(true)
        expect(mockFetch).toHaveBeenCalledWith(
            'http://localhost:1234/v1/models',
            expect.objectContaining({method: 'GET'})
        )
    })

    it('should return false when server responds not ok', async () => {
        mockFetch.mockResolvedValue({ok: false})
        const result = await checkLlamaCppHealth('http://localhost:1234')
        expect(result).toBe(false)
    })

    it('should return false on fetch error', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
        const result = await checkLlamaCppHealth('http://localhost:1234')
        expect(result).toBe(false)
    })
})

describe('discoverLlamaCppModels', () => {
    it('should return models from API', async () => {
        const models = [
            {id: 'model-1', object: 'model', created: 1, owned_by: 'local'},
            {id: 'model-2', object: 'model', created: 2, owned_by: 'local'},
        ]
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({data: models}),
        })

        const result = await discoverLlamaCppModels('http://localhost:1234')
        expect(result).toEqual(models)
    })

    it('should return empty array when data is missing', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({}),
        })

        const result = await discoverLlamaCppModels('http://localhost:1234')
        expect(result).toEqual([])
    })

    it('should return empty array when response is not ok', async () => {
        mockFetch.mockResolvedValue({ok: false})
        const result = await discoverLlamaCppModels('http://localhost:1234')
        expect(result).toEqual([])
    })

    it('should throw on fetch error', async () => {
        mockFetch.mockRejectedValue(new Error('network fail'))
        await expect(discoverLlamaCppModels('http://localhost:1234')).rejects.toThrow(
            'Failed to discover models'
        )
    })
})

describe('fetchLlamaCppModelsDirect', () => {
    it('should return model IDs from API', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                data: [
                    {id: 'model-1', object: 'model', created: 1, owned_by: 'local'},
                    {id: 'model-2', object: 'model', created: 2, owned_by: 'local'},
                ],
            }),
        })

        const result = await fetchLlamaCppModelsDirect('http://localhost:1234')
        expect(result).toEqual(['model-1', 'model-2'])
    })

    it('should return empty array on HTTP error (caught internally)', async () => {
        mockFetch.mockResolvedValue({ok: false, status: 500, statusText: 'Server Error'})
        const result = await fetchLlamaCppModelsDirect('http://localhost:1234')
        expect(result).toEqual([])
    })

    it('should return empty array on fetch failure', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
        const result = await fetchLlamaCppModelsDirect('http://localhost:1234')
        expect(result).toEqual([])
    })

    it('should return empty array when data is empty', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({data: []}),
        })
        const result = await fetchLlamaCppModelsDirect('http://localhost:1234')
        expect(result).toEqual([])
    })
})

describe('autoDetectLlamaCpp', () => {
    it('should return first healthy URL', async () => {
        mockFetch.mockResolvedValue({ok: true})
        const result = await autoDetectLlamaCpp()
        // 1234 has the highest priority.
        expect(result).toBe('http://127.0.0.1:1234')
    })

    it('should try port 9931 if 1234 is down', async () => {
        mockFetch
            .mockResolvedValueOnce({ok: false})  // port 1234
            .mockResolvedValueOnce({ok: true})   // port 9931
        const result = await autoDetectLlamaCpp()
        expect(result).toBe('http://127.0.0.1:9931')
    })

    it('should try port 8080 if 1234 and 9931 are down', async () => {
        mockFetch
            .mockResolvedValueOnce({ok: false})  // port 1234
            .mockResolvedValueOnce({ok: false})  // port 9931
            .mockResolvedValueOnce({ok: true})   // port 8080
        const result = await autoDetectLlamaCpp()
        expect(result).toBe('http://127.0.0.1:8080')
    })

    it('should try port 11434 if others are down', async () => {
        mockFetch
            .mockResolvedValueOnce({ok: false})  // port 1234
            .mockResolvedValueOnce({ok: false})  // port 9931
            .mockResolvedValueOnce({ok: false})  // port 8080
            .mockResolvedValueOnce({ok: true})   // port 11434
        const result = await autoDetectLlamaCpp()
        expect(result).toBe('http://127.0.0.1:11434')
    })

    it('should respect an explicit port list', async () => {
        mockFetch.mockResolvedValue({ok: true})
        const result = await autoDetectLlamaCpp([9931])
        expect(result).toBe('http://127.0.0.1:9931')
        expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should pick by priority, not by whichever port replies first', async () => {
        // 1234 is slow but healthy; 9931 replies immediately. Priority must still win.
        mockFetch.mockImplementation(async (url: string) => {
            if (url.includes('1234')) {
                await new Promise((resolve) => setTimeout(resolve, 20))
                return {ok: true}
            }
            return {ok: true}
        })
        const result = await autoDetectLlamaCpp()
        expect(result).toBe('http://127.0.0.1:1234')
    })

    it('should return null if no server found', async () => {
        mockFetch.mockResolvedValue({ok: false})
        const result = await autoDetectLlamaCpp()
        expect(result).toBeNull()
    })

    it('should return null on fetch errors', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
        const result = await autoDetectLlamaCpp()
        expect(result).toBeNull()
    })
})
