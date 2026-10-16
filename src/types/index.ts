// Core types for llama.cpp plugin
export interface LlamaCppModelArchitecture {
    input_modalities?: string[]
    output_modalities?: string[]
}

export interface LlamaCppModelCapabilities {
    function_calling?: boolean
    vision?: boolean
}

/**
 * Per-model server state from `llama-server`'s router mode (`GET /models`).
 *
 * For an *unloaded* model this is the only place the effective context size
 * appears — as `-c` / `--ctx-size` in the launch args. The richer `meta` block
 * (`n_ctx_train`, `n_vocab`, `n_params`, …) is only forwarded once the model is
 * actually loaded, so it cannot be relied on during discovery.
 */
export interface LlamaCppModelStatus {
    value?: string
    args?: string[]
    preset?: string
}

export interface LlamaCppModel {
    id: string
    object: string
    created: number
    owned_by: string
    path?: string
    name?: string
    context_length?: number
    context_window?: number
    architecture?: LlamaCppModelArchitecture
    capabilities?: LlamaCppModelCapabilities
    supported_parameters?: string[]
    status?: LlamaCppModelStatus
    meta?: {
        vocab_type?: number
        n_vocab?: number
        n_ctx_train?: number
        n_embd?: number
        n_params?: number
    }
}

export interface LlamaCppModelsResponse {
    object: string
    data: LlamaCppModel[]
}

/**
 * Resolved chat-template capabilities from `GET /props`.
 *
 * llama.cpp has no static field for function-calling support — it depends on the
 * chat template plus `--jinja`. These caps are that dependency already resolved,
 * so they are the authoritative answer rather than a guess from model naming.
 */
export interface LlamaCppChatTemplateCaps {
    supports_tools?: boolean
    supports_tool_calls?: boolean
    supports_parallel_tool_calls?: boolean
    supports_object_arguments?: boolean
}

export interface LlamaCppProps {
    model_alias?: string
    model_path?: string
    model_ftype?: string
    total_slots?: number
    is_sleeping?: boolean
    modalities?: {
        vision?: boolean
        video?: boolean
        audio?: boolean
    }
    chat_template?: string
    chat_template_caps?: LlamaCppChatTemplateCaps
    default_generation_settings?: {
        n_ctx?: number
    }
}

export type ModelType = 'chat' | 'embedding' | 'unknown'

export interface ModelValidationError {
    type: 'offline' | 'not_found' | 'network' | 'permission' | 'timeout' | 'unknown'
    severity: 'low' | 'medium' | 'high' | 'critical'
    message: string
    canRetry: boolean
    autoFixAvailable: boolean
}

export interface AutoFixSuggestion {
    action: string
    command?: string
    steps?: string[]
    automated: boolean
}

export interface SimilarModel {
    model: string
    similarity: number
    reason: string
}

export interface CacheStats {
    size: number
    entries: Array<{
        baseURL: string
        age: number
        modelCount: number
        ttl: number
    }>
}
