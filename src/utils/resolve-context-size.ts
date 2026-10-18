import type {LlamaCppModel} from '../types'

/**
 * Context size assumed when the server reports none.
 *
 * The SDK's `Model.Info.default` advertises 200_000. That is a fine guess for a
 * hosted frontier model and a dangerous one for a local llama.cpp server:
 * over-reporting context does not fail loudly, it silently overruns the KV
 * cache, spills into system RAM, and collapses decode throughput. Under-
 * reporting merely truncates the conversation earlier than necessary.
 *
 * When in doubt the failure should be the quiet one, so the default is set well
 * below any plausible local server. Most real local servers run 32_000 to
 * 131_072 and report it explicitly, so this only applies when discovery finds
 * no `--ctx-size` at all.
 */
export const FALLBACK_CONTEXT_SIZE = 16_384

/**
 * Resolve the model's effective context size.
 *
 * `llama-server`'s router mode reports no context field for an *unloaded*
 * model — the value only appears as `-c` / `--ctx-size` in the per-model launch
 * args in `status.args`. Without this the plugin falls back to
 * `Model.Info.default`'s 200_000, over-reporting by up to 3x against servers
 * running 65_536–131_072, which causes context-overflow failures.
 *
 * Note this is the *serving* context (`n_ctx`), not `meta.n_ctx_train`, which
 * is the model's trained maximum and is only present once loaded.
 */
export function resolveContextSize(model: LlamaCppModel): number | undefined {
    if (model.context_length) return model.context_length
    if (model.context_window) return model.context_window

    // Present only once loaded, and authoritative when it is.
    if (model.meta?.n_ctx) return model.meta.n_ctx

    const args = model.status?.args
    if (!Array.isArray(args)) return undefined

    // llama.cpp accepts both the short and long spelling. The long form is
    // checked first so a value that happens to equal `-c` cannot win.
    for (const flag of ['--ctx-size', '-c']) {
        const index = args.indexOf(flag)
        if (index === -1) continue
        const value = Number(args[index + 1])
        if (Number.isFinite(value) && value > 0) return value
    }

    return undefined
}