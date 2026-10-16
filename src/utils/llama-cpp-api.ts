import type {LlamaCppModel, LlamaCppModelsResponse, LlamaCppProps} from '../types'

const DEFAULT_LLAMA_CPP_URL = "http://127.0.0.1:1234"
const LLAMA_CPP_MODELS_ENDPOINT = "/v1/models"

/**
 * Ports probed during auto-detection, in priority order.
 *
 * 1234 is llama.cpp's long-standing default; 9931 is the newer default that
 * replaced 8080; 8080 is the older llama.cpp default; 11434 is Ollama.
 *
 * Override per-project with plugin options, e.g.
 * `{"plugin": ["opencode-plugin-llama.cpp", {"ports": [1234, 9931]}]}`.
 */
export const DEFAULT_LLAMA_CPP_PORTS: readonly number[] = [1234, 9931, 8080, 11434]

// Normalize base URL to ensure consistent format
export function normalizeBaseURL(baseURL: string = DEFAULT_LLAMA_CPP_URL): string {
    // Remove trailing slash
    let normalized = baseURL.replace(/\/+$/, '')

    // Remove /v1 suffix if present
    if (normalized.endsWith('/v1')) {
        normalized = normalized.slice(0, -3)
    }

    return normalized
}

// Build full API URL with endpoint
export function buildAPIURL(baseURL: string, endpoint: string = LLAMA_CPP_MODELS_ENDPOINT): string {
    const normalized = normalizeBaseURL(baseURL)
    return `${normalized}${endpoint}`
}

// Check if llama.cpp is accessible
export async function checkLlamaCppHealth(baseURL: string = DEFAULT_LLAMA_CPP_URL): Promise<boolean> {
    try {
        const url = buildAPIURL(baseURL)
        const response = await fetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(3000),
        })
        return response.ok
    } catch {
        return false
    }
}

// Discover models from llama.cpp API
export async function discoverLlamaCppModels(baseURL: string = DEFAULT_LLAMA_CPP_URL): Promise<LlamaCppModel[]> {
    try {
        const url = buildAPIURL(baseURL)
        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(3000),
        })

        if (!response.ok) {
            return []
        }

        const data = (await response.json()) as LlamaCppModelsResponse
        return data.data ?? []
    } catch (error) {
        throw new Error(`Failed to discover models: ${error instanceof Error ? error.message : String(error)}`)
    }
}

// Get currently loaded/active models from llama.cpp (bypass cache)
export async function fetchLlamaCppModelsDirect(baseURL: string = DEFAULT_LLAMA_CPP_URL): Promise<string[]> {
    try {
        const url = buildAPIURL(baseURL)
        const response = await fetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(3000),
        })
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const data = (await response.json()) as LlamaCppModelsResponse
        return data.data?.map((model: LlamaCppModel) => model.id) || []
    } catch {
        return []
    }
}

/**
 * Fetch a single model's `/props`.
 *
 * In router mode this endpoint requires `?model=<id>`; without it llama-server
 * answers HTTP 400 `model name is missing from the request`. Headers such as
 * `x-model` are not accepted.
 *
 * Caution: this **loads the model** when `models_autoload` is on (the default).
 * It is fast (~0.1s) for a model already in use and slow for a cold one, so
 * callers must bound the timeout and must not block a request on it.
 */
export async function fetchModelProps(
    baseURL: string,
    model: string,
    timeoutMs = 2000,
): Promise<LlamaCppProps | null> {
    try {
        const url = `${normalizeBaseURL(baseURL)}/props?model=${encodeURIComponent(model)}`
        const response = await fetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) return null
        return (await response.json()) as LlamaCppProps
    } catch {
        // Timeout, HTTP 400 (model not routable), or a malformed payload.
        return null
    }
}

/**
 * Auto-detect llama.cpp if not configured.
 *
 * Ports are probed concurrently so startup cost stays flat as the list grows,
 * but the winner is still chosen by priority order (not by whichever replies
 * first) so detection is deterministic.
 */
export async function autoDetectLlamaCpp(ports: readonly number[] = DEFAULT_LLAMA_CPP_PORTS): Promise<string | null> {
    const health = await Promise.all(
        ports.map(async (port) => checkLlamaCppHealth(`http://127.0.0.1:${port}`)),
    )

    const index = health.findIndex((healthy) => healthy)
    return index === -1 ? null : `http://127.0.0.1:${ports[index]}`
}