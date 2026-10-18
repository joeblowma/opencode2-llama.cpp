#!/usr/bin/env bun
/**
 * Diagnose llama.cpp plugin setup.
 *
 * Answers the question you actually have when the plugin misbehaves: which
 * llama.cpp server did it settle on, and can it reach it? It exercises the same
 * resolution and probe functions the plugin uses at startup, so the output
 * reflects real behaviour rather than a reimplementation of it.
 *
 * Usage: pnpm run doctor            # auto-detect
 *        pnpm run doctor -- http://localhost:9931
 */

import {existsSync, readFileSync} from 'fs'
import {join} from 'path'
import {parseJsonc} from '../src/utils/jsonc'
import {resolveContextSize, FALLBACK_CONTEXT_SIZE} from '../src/utils/resolve-context-size'
import {
    DEFAULT_LLAMA_CPP_PORTS,
    autoDetectLlamaCpp,
    checkLlamaCppHealth,
    discoverLlamaCppModels,
    normalizeBaseURL,
} from '../src/utils/llama-cpp-api'

const PROVIDER_ID = 'llama.cpp'

/** Same search order and shapes as `readBaseURLFromConfig` in config-hook.ts. */
function readBaseURLFromConfig(): string | null {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const cwd = process.cwd()

    const configPaths = [
        join(home, '.config/opencode/opencode.json'),
        join(home, '.config/opencode/opencode.jsonc'),
        join(cwd, 'opencode.json'),
        join(cwd, 'opencode.jsonc'),
        join(cwd, '.opencode/opencode.json'),
        join(cwd, '.opencode/opencode.jsonc'),
    ]

    for (const configPath of configPaths) {
        if (!existsSync(configPath)) continue

        try {
            const config = parseJsonc<any>(readFileSync(configPath, 'utf-8'))
            // V2 uses `providers`/`settings`, V1 used `provider`/`options`.
            const declared = config.providers?.[PROVIDER_ID] ?? config.provider?.[PROVIDER_ID]
            const baseURL = declared?.settings?.baseURL ?? declared?.options?.baseURL
            if (baseURL) return baseURL
        } catch (error) {
            console.log(`  ! could not parse ${configPath}: ${error instanceof Error ? error.message : error}`)
        }
    }

    return null
}

async function main() {
    const arg = process.argv[2]
    console.log('llama.cpp plugin diagnostics\n')

    let baseURL: string | null = null
    let source = ''

    if (arg) {
        baseURL = normalizeBaseURL(arg)
        source = 'command-line argument'
    } else {
        const fromConfig = readBaseURLFromConfig()
        if (fromConfig) {
            baseURL = normalizeBaseURL(fromConfig)
            source = 'config file'
        } else {
            console.log(`No llama.cpp baseURL in config; probing ports ${DEFAULT_LLAMA_CPP_PORTS.join(', ')}...`)
            baseURL = await autoDetectLlamaCpp()
            source = 'port scan'
        }
    }

    if (!baseURL) {
        console.log('\nResult: no llama.cpp server found.')
        console.log(`Start one, or pass a URL: pnpm run doctor -- http://localhost:${DEFAULT_LLAMA_CPP_PORTS[0]}`)
        process.exit(1)
    }

    console.log(`baseURL: ${baseURL}  (from ${source})`)

    const healthy = await checkLlamaCppHealth(baseURL)
    console.log(`health:  ${healthy ? 'reachable' : 'UNREACHABLE'}`)

    if (!healthy) {
        console.log('\nResult: server is not answering on /v1/models.')
        console.log('The plugin will fall back to scanning other ports; check the server is actually running.')
        process.exit(1)
    }

    try {
        const models = await discoverLlamaCppModels(baseURL)
        console.log(`models:  ${models.length} discovered`)
        for (const model of models.slice(0, 10)) {
            // Same resolution the plugin applies, so this reflects what the
            // catalog will actually advertise rather than just the API fields.
            const ctx = resolveContextSize(model)
            const loaded = model.status?.value === 'loaded'
            console.log(`  - ${model.id}  (ctx ${ctx ?? '?'}${loaded ? ', loaded' : ''})`)
        }
        if (models.length > 10) console.log(`  ... and ${models.length - 10} more`)

        // Models with no reported context fall back to the conservative
        // default rather than the SDK's 200k, which would over-report and
        // cause silent KV-cache spill into system RAM.
        const unresolved = models.filter((m) => resolveContextSize(m) === undefined)
        if (unresolved.length > 0) {
            console.log(`\n! ${unresolved.length} model(s) report no context size;`)
            for (const m of unresolved) console.log(`    ${m.id}`)
            console.log(`  They will advertise ${FALLBACK_CONTEXT_SIZE} (the fallback), not 200k.`)
            console.log('  Set --ctx-size / -c on the server, or pass a fallbackContext option.')
        } else {
            console.log(`\nall ${models.length} models report a context size (no fallback needed)`)
        }
    } catch (error) {
        console.log(`models:  discovery failed: ${error instanceof Error ? error.message : error}`)
        process.exit(1)
    }

    console.log('\nResult: plugin setup looks good.')
}

main().catch((error) => {
    console.error('Unexpected error:', error)
    process.exit(1)
})