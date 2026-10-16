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

| Option    | Type       | Default                        | Notes                                                          |
| --------- | ---------- | ------------------------------ | -------------------------------------------------------------- |
| `baseURL` | `string`   | —                              | Highest priority; wins even over a provider already configured. `/v1` suffix optional |
| `ports`   | `number[]` | `[1234, 9931, 8080, 11434]`    | Restricts auto-detection to these ports, in priority order      |

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

Set the `DEBUG` environment variable to enable verbose logging:

```bash
DEBUG=1 opencode
```

Log lines are prefixed with `[opencode-llama-cpp]`.

## Requirements

- OpenCode (V2)
- llama.cpp server running locally (default port: 1234)
- Node.js 18+ (global `fetch`)

## Development

The project uses pnpm exclusively.

```bash
pnpm install        # install dependencies
pnpm test           # run unit tests (143 tests)
pnpm test:coverage  # run tests with coverage report
pnpm validate       # lint + typecheck + tests
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
