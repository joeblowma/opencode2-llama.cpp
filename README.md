# opencode-llama-cpp

OpenCode V2 plugin for enhanced llama.cpp support with auto-detection, dynamic model discovery, and enriched model metadata.

> **Note**: The migration to the OpenCode V2 API (and related development work) was carried out with the assistance of AI tools. Code correctness and behavior should be reviewed before production use.

## Features

- **Auto-detection**: Automatically detects a llama.cpp server running on common ports (1234, 9931, 8080, 11434)
- **Dynamic Model Discovery**: Queries llama.cpp's `/v1/models` endpoint and registers discovered models into the OpenCode catalog (V2 API)
- **Enriched Model Metadata**:
  - Human-readable display names, preferring the name provided by the API (e.g., "Qwen3 30B A3B" instead of "qwen/qwen3-30b-a3b")
  - Context limit from `context_length` / `context_window`, falling back to
    `-c` / `--ctx-size` in the per-model `status.args`. `llama-server`'s router
    mode reports no context field for an *unloaded* model, so without this the
    limit would be wrong by up to 3x
  - Release date from the model's `created` field
  - Tool support detection (`function_calling` / `tools` parameter)
  - Input/output modalities, preferring the server's declared
    `architecture.input_modalities` / `output_modalities` over name-based guessing,
    with embedding models classified accordingly
- **Model Validation**: A session context hook verifies that the selected model is actually loaded on the server (with retry/backoff) and adds a system warning to the prompt if it is not
- **Tool-Calling Detection**: llama.cpp has no static capability field — function calling depends on the chat template plus `--jinja`. For the model you are actually using, the plugin resolves this from `chat_template_caps` in `/props` and enables tools in the catalog. It probes **only models already loaded**, because merely requesting `/props?model=` autoloads a model and aborting the fetch does not cancel that server-side load. Results are cached per model, and a confirmed `false` never overrides a value you set yourself
- **Periodic Refresh**: Re-discovers models every 60 seconds and reloads the catalog
- **Health Check Monitoring**: Verifies the llama.cpp server is accessible before attempting operations
- **Caching**: A single shared model status cache reduces redundant API calls
- **Error Handling**: Smart error categorization with actionable messages
- **Logging**: Centralized logger with an `[opencode-llama-cpp]` prefix; set `DEBUG=1` for verbose debug output

## Installation

```bash
pnpm add opencode-plugin-llama.cpp
```

## Usage

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-plugin-llama.cpp"
  ],
  "providers": {
    "llama.cpp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "llama.cpp (local)",
      "settings": {
        "baseURL": "http://127.0.0.1:1234"
      }
    }
  }
}
```

Note the key is `plugins` (plural) in V2; `plugin` (singular) is V1 and is ignored.

Both configuration formats are supported:

- **V1**: `provider` with `options.baseURL`
- **V2**: `providers` with `settings.baseURL`

`baseURL` may include or omit the `/v1` suffix — it is normalized automatically.

### Auto-detection

If you don't configure the `llama.cpp` provider, the plugin will automatically detect a llama.cpp server on one of the common ports and register the provider configuration for you.

Ports are probed in priority order — `1234`, `9931`, `8080`, `11434` — where `9931` is the
newer llama.cpp default that replaced `8080`. Ports are checked concurrently, but the
winner is chosen by priority rather than by whichever replies first, so detection is
deterministic.

### Plugin options

llama.cpp's default port has moved more than once, so both the endpoint and the port list
can be overridden without touching the code:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    ["opencode-plugin-llama.cpp", {"baseURL": "http://127.0.0.1:9931"}]
  ]
}
```

| Option             | Type       | Default                        | Notes                                                          |
| ------------------ | ---------- | ------------------------------ | -------------------------------------------------------------- |
| `baseURL`          | `string`   | —                              | Highest priority; wins even over a provider already configured. `/v1` suffix optional |
| `ports`            | `number[]` | `[1234, 9931, 8080, 11434]`    | Restricts auto-detection to these ports, in priority order      |
| `fallbackContext`  | `number`   | `16384`                        | Context to advertise only when the server reports none. Minimum `4096`; see [Context size](#context-size) |

### Manual Configuration

You can also manually configure the provider with specific models:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-plugin-llama.cpp"
  ],
  "providers": {
    "llama.cpp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "llama.cpp (local)",
      "settings": {
        "baseURL": "http://127.0.0.1:1234"
      }
    }
  }
}
```

The plugin will automatically discover and register any additional models available on the llama.cpp server that aren't already configured.

### Context size

Advertising more context than a server can actually serve is the most damaging thing this
plugin could get wrong, because it fails *quietly*: the KV cache overruns, spills out of VRAM
into system RAM, and decode throughput collapses rather than erroring.

So the plugin reads the real serving context from the server instead of assuming:

1. `context_length` or `context_window` on the model, when the server reports one
2. Otherwise `-c` / `--ctx-size` in the model's launch args — the only place it appears for a
   model that is not currently loaded
3. Otherwise `16384`

That third case is deliberately far below OpenCode's own 200,000 default. The SDK default
assumes hosted infrastructure; a local llama.cpp server is far more likely to be configured
at 32k–131k. When the failure mode is "quietly slow", guessing low only costs you some
conversation history, while guessing high costs you throughput.

In practice step 3 is rare — `llama-server` reports `--ctx-size` for essentially every model.
Run `pnpm run doctor` to confirm yours do; if any fall back, set `fallbackContext` to match
your hardware:

```json
["opencode-plugin-llama.cpp", {"fallbackContext": 32768}]
```

This value is only consulted when the server reports nothing, so raising it never overrides a
correctly-detected context size.

## How It Works

1. On OpenCode startup, the plugin's `setup` function runs and resolves the llama.cpp base URL:
   1. From the OpenCode provider catalog (`ctx.provider.list()`)
   2. Otherwise from `opencode.json` / `opencode.jsonc` files (global and project-level), supporting both V2 (`providers.settings.baseURL`) and V1 (`provider.options.baseURL`) formats
   3. Otherwise by auto-detecting a llama.cpp server on localhost ports 1234, 9931, 8080, and 11434
2. If a server is found, its health is checked via the `/v1/models` endpoint
3. A single `ctx.provider.transform` is registered. It is replayable and reads from an
   in-memory snapshot, so it never fetches and never re-registers itself:
   - If the `llama.cpp` provider is **absent**, it is added outright with the OpenAI-compatible
     driver (`@opencode/ai/providers/openai-compatible`)
   - If it is **already declared**, it is left in place and only its name, activation, and
     `baseURL` are corrected
   - Discovered models are merged into the provider's model list, enriched with metadata
     (display name, limits, capabilities, modalities). Models declared in `opencode.json`
     that the server does not advertise are preserved
4. Models are re-discovered every 60 seconds; the catalog is reloaded only when the
   discovered set actually changed
5. On every agent-loop request, a `session` `context` hook validates that the selected model
   is loaded on the server (with retry/backoff); if validation fails, a warning is added to
   the system prompt

## Debugging

### `pnpm run doctor`

Answers the two questions that matter when the plugin misbehaves — which server it settled on,
and can it reach it — by calling the same functions the plugin uses at startup:

```bash
pnpm run doctor                          # resolve from config, else scan ports
pnpm run doctor -- http://localhost:9931 # override the lookup
```

```
baseURL: http://localhost:9931  (from config file)
health:  reachable
models:  21 discovered
  - JackOD-9B-Coder-MTP-v4  (ctx 65536)
  ...
all 21 models report a context size (no fallback needed)

Result: plugin setup looks good.
```

It reads `.json` and `.jsonc` config (comments and trailing commas included) and exits non-zero
when no server is reachable, so it works in CI or a pre-commit hook.

### Debug logging

Set the `DEBUG` environment variable to enable verbose logging:

```bash
DEBUG=1 opencode
```

Log lines are prefixed with `[opencode-llama-cpp]`.

### Plugin fails to load

OpenCode reports this as an opaque `err_XXXXXXXX`. The real cause is in its log:

```bash
grep "failed to load plugin" ~/.local/share/opencode/log/opencode.log
```

The hash changes with every failure, so treat a changing code as one problem rather than a new
one. A `Cannot find package` cause means a broken dependency tree; repair it with
`pnpm install --force` (a plain install can report "Already up to date" while the packages are
missing) and then **fully restart OpenCode** — the runtime caches module resolution, so a running
server will not pick up the repair.

## Requirements

- OpenCode (V2)
- llama.cpp server running locally (default port: 1234)
- Node.js 18+ (global `fetch`)

## Development

The project uses pnpm exclusively.

```bash
pnpm install        # install dependencies
pnpm test           # run unit tests
pnpm test:coverage  # run tests with coverage report
pnpm validate       # lint + typecheck + tests
pnpm doctor         # diagnose a running llama.cpp server
```

Runtime dependencies are kept to `@opencode/plugin` alone — everything else is dev-only, so a
missing or corrupt `node_modules` cannot prevent the plugin from loading.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
