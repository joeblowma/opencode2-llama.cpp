# OpenCode V2 plugin porting handoff

Distilled from porting `opencode-codex-usage` → V2 (`opencode-codex-usagex`).
Written so a new session can port another plugin without re-deriving the API.

## Documentation (use these, not the legacy ones)

| Topic                              | URL                                                    |
| ---------------------------------- | ------------------------------------------------------ |
| Plugin overview + full context API | `https://opencode.ai/v2/docs/build/plugins`            |
| **V1 → V2 migration guide**        | `https://opencode.ai/v2/docs/build/plugins/migrate-v1` |
| CLI / TUI (terminal) plugins       | `https://opencode.ai/v2/docs/build/plugins/cli`        |
| Plugin RPC                         | `https://opencode.ai/v2/docs/build/plugins/rpc`        |

> **Trap:** `https://opencode.ai/docs/plugins` is the **V1** page and still shows
> `export const MyPlugin = async (ctx) => ({...})`. It is not stale, it is a
> different site. Always use the `/v2/docs/` prefix.

When the docs and the installed `.d.ts` disagree, the installed types win — they
are what the running binary actually accepts.

## The one rule that breaks everything

A V2 plugin **default-exports a definition object**, not a function:

```ts
import { Plugin } from "@opencode/plugin"; // server
// import { Plugin } from "@opencode/plugin/tui" // TUI

export default Plugin.define({
  id: "stable-id", // required; scopes storage and identifies the plugin
  setup(ctx) {
    /* ... */ return () => {
      /* cleanup */
    };
  },
});
```

A bare function fails with:

```
Plugin must export a default definition with an id and an effect or setup function.
(cause: SchemaError(Expected object at ["default"]))
```

Note `@opencode/plugin`'s **default export is the Promise variant**. The Effect
variant is a separate subpath (`@opencode/plugin/effect`). Importing the default
gives you `setup(ctx) => Promise<Cleanup | void>`.

## Failure signatures and what they mean

| Log / symptom                                       | Cause                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `Cannot find package 'zod' imported from ...`       | `node_modules` missing in the plugin dir                              |
| `SchemaError: Expected object at ["default"]`       | Still exporting a V1 function                                         |
| `rpc handler failed rpc=<id> method=<m>` → HTTP 500 | Handler **threw**. See "make RPC total" below.                        |
| `unhandled rejection cause.type=rpc.internal`       | Caller did not `catch`. Symptom can be a UI stuck on a loading state. |

Two **silent** failures produce no error at all, so they never reach this table —
check them first when a plugin "does nothing":

| Symptom                                                  | Cause                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Absent from `opencode plugin list`; no `loading plugin` log line | Directory entry with no root `index.ts` (see below)            |
| Loads cleanly, no errors, but registers nothing          | Only called `editor.update(...)` — it cannot create. See below.        |

## Server plugin essentials

```ts
async setup(ctx) {
  // Credentials: never read auth files. OpenCode owns credential storage.
  const connection = await ctx.integration.connection.active("openai");
  if (!connection) return undefined;
  const credential = await ctx.integration.connection.resolve(connection);
  // credential.type === "oauth" | ...; credential.access is the token

  // Tool registration (replaces V1's `tool` map)
  const reg = await ctx.tool.transform((editor) =>
    editor.add({
      name: "my_tool",
      description: "…",
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      execute: async (input, context) => ({ content: "…" }), // context.signal
    }),
  );

  // Durable plugin state
  await ctx.storage.set("settings", { strict: true });
  const opts = ctx.options; // from config { package, options } object form

  return () => { void reg.dispose(); };
}
```

Events on the server are an async stream — **not** the TUI's `data.on`:

```ts
const controller = new AbortController();
void (async () => {
  for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
    /* … */
  }
})();
return () => controller.abort();
```

## Hook migration table (V1 → V2)

Hooks are registered on the domain that owns the operation and receive one
mutable event. Save the returned registration only to dispose early.

| V1 hook                            | V2                                       |
| ---------------------------------- | ---------------------------------------- |
| `event`                            | `ctx.event.subscribe()`                  |
| `dispose`                          | cleanup function returned by `setup`     |
| `config` / `provider` / `tool` map | `ctx.<domain>.transform(...)`            |
| `tool.execute.before` / `.after`   | `ctx.tool.hook("execute.before", ...)`   |
| `chat.message`                     | `ctx.session.hook("prompt", ...)`        |
| `chat.params`                      | `ctx.session.hook("context", ...)`       |
| `chat.headers`                     | `ctx.session.hook("model.request", ...)` |
| `shell.env`                        | `ctx.shell.hook("create.before", ...)`   |
| `permission.ask`                   | `ctx.permission.hook("evaluate", ...)`   |
| `auth`                             | `ctx.integration.transform(...)`         |

`context` runs for the agent loop; `compaction`, `generate`, and `title` are
separate hooks. A transformation that must apply to **every** model request has
to register each one.

## Registering a provider (e.g. a local llama.cpp server)

This is the modern replacement for a hand-written `providers` block in config:

```ts
import { Model, Plugin, Provider } from "@opencode/plugin";

const providerID = Provider.ID.make("llama.cpp");
await ctx.provider.transform((editor) => {
  editor.add({
    info: {
      ...Provider.Info.empty(providerID),
      name: "llama.cpp (local)",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:9931/v1" },
    },
    models: [{ ...Model.Info.default(providerID, Model.ID.make("local")), name: "Local" }],
    // sourceConnection: connection,  // swap inventory per active connection
  });
});
// provider-wide model filtering / overrides:
await ctx.model.transform((editor) => {
  /* editor.remove(...) */
});
```

Transforms are **replayable state edits**: keep the callback synchronous, cheap,
and free of one-off side effects. Load external data _before_ registering,
capture it in the closure, and call the domain's `reload()` when it changes.

### The trap that fails silently: `update` cannot create

This is the single most expensive mistake in a V2 port, because the plugin
**loads fine, throws nothing, logs nothing, and registers nothing.**

| Call                                | Can create a missing target?                       |
| ----------------------------------- | -------------------------------------------------- |
| `editor.update(providerID, fn)`     | **No** — no-op if the provider does not exist       |
| `editor.models.update(pid, mid, fn)`| **No** — no-op if the model is not already there     |
| `editor.models.set(pid, models)`    | Replaces the whole list for an existing provider     |
| `editor.add({ info, models })`      | **Yes** — the only way to create provider *or* model|

So a plugin written as "discover models, then `update` them onto my provider"
works perfectly on a machine where the provider is already declared in config,
and does **absolutely nothing** anywhere else. Worse, `models.update` no-ops per
model, so if the provider exists but the models don't, discovery silently
produces an empty result.

Branch on `editor.get(providerID)`:

```ts
const existing = editor.get("llama.cpp")
if (existing) {
  editor.update("llama.cpp", (p) => { /* correct name/activation/baseURL */ })
  // Merge, don't clobber: models declared in config must survive a refresh.
  const merged = new Map(existing.models)
  for (const m of discovered) merged.set(m.id, enrich(m))
  editor.models.set("llama.cpp", [...merged.values()])
} else {
  editor.add({ info: { /* … */ }, models: discovered.map(enrich) })
}
```

Don't rely on `editor.get()` seeing a provider you just `add`ed in the same
callback — pass the full model list to `add()` and skip the read-back.

Two more things that bite in the same place:

- **`ModelEditor.update` is weaker still.** It "edits raw model overrides; cannot
  create an unavailable provider". Use `ctx.provider.transform` when you are
  adding models, not `ctx.model.transform`.
- **Transforms accumulate.** Registering a *new* transform on every refresh tick
  stacks duplicate catalog edits forever. Register once and let the callback read
  from mutable state you update out-of-band, then call `reload()`.

### Type-level gotchas

- **`Model.Info` is deeply readonly.** The editors hand out mutable copies, so
  `Model.Info.default(...)` returns something you cannot assign to. Either build
  a new object, or use the SDK's own `DeepMutable` for the depth you touch.
- **`Model.ID.make` / `Provider.ID.make` work at runtime but are absent from the
  inferred `Schema.brand` type.** You need a cast helper, e.g.
  `const modelID = (id: string) => id as Model.ID`.
- **Don't mutate fields V2 removed.** `organizationOwner` is gone from
  `Model.Info`; assigning it is a silent no-op (and typechecks only because the
  parameter was `any`).
- **Required numerics matter.** `limit.context` and `limit.output` are required
  `Int`s. `Model.Info.default()` supplies them, so always spread it rather than
  constructing a `Model.Info` from scratch.

### Import `Provider` / `Model` from `@opencode/plugin`

```ts
import { Model, Provider, Plugin } from "@opencode/plugin"; // ✅ re-exported
import { Provider } from "@opencode/schema/provider";     // ⚠️ may not resolve
```

Under **pnpm** only your direct dependencies are linked at the root;
`@opencode/schema`, `@opencode/ai`, `effect` and friends live in `.pnpm/` as
private siblings. `import("@opencode/schema/provider")` from your plugin root
fails with *Cannot find module*, while `import("@opencode/plugin")` succeeds and
re-exports `Provider`, `Model`, `Agent`, `Rpc`, `Session`, … — and that is the
supported path anyway. Under npm's flat `node_modules` the direct import would
resolve, so this only bites once you move to pnpm.

### Verify enrichment against the real payload, not the assumed one

The third way this plugin failed was quieter than the first two: it loaded, it
registered, it produced plausible-looking numbers — all of them wrong.

In `llama-server`'s **router mode**, `GET /models` returns **none** of
`context_length`, `capabilities`, `supported_parameters`, or `meta` for an
*unloaded* model. Every one of those 21 models therefore fell through to
`Model.Info.default()`, and OpenCode was told each had a **200,000**-token context
when the server was actually running them at **65,536–131,072**. OpenCode packs
prompts believing there is room, and the request dies on overflow.

What each source is actually good for:

| Fact                | Where it lives                                   | Cost                |
| ------------------- | ------------------------------------------------ | ------------------- |
| Serving context     | `-c` / `--ctx-size` in `status.args`             | free                |
| Input/output modalities | `architecture.*` in `/models`               | free — computed offline from GGUF/projector |
| `meta` (`n_ctx_train`, `n_params`, …) | `/models`, **only once loaded**    | requires a load     |
| Tool calling        | `chat_template_caps` in `/props?model=`          | requires a load     |

Two documented gotchas: `n_ctx_train` is the model's *trained* maximum, not the
serving window — do not use it for `limit.context`. And offline computation
**cannot detect `video`**; only a loaded model reports it.

Lessons:

1. **Dump the raw payload before trusting an enrichment path.** One
   `curl …/models | jq '.data[0]'` settles what the server actually exposes.
   Fields an LLM will happily assume are present usually are not.
2. **Treat `Model.Info.default()` values as placeholders, not answers.** Every
   field it fills in is a guess. If your real data doesn't override it, you are
   publishing the guess to the model router.
3. **In router mode, GET endpoints take `?model=<id>`.** `/props`, `/slots`,
   `/metrics`, `/lora-adapters` all return HTTP 400 `model name is missing from
   the request` without it. Headers such as `x-model` are **not** accepted.
4. **`/props?model=` autoloads, and a timeout does NOT cancel it.** With
   `models_autoload` on (the default) the server starts loading the moment you
   request it; aborting the client fetch leaves the load running. A short timeout
   is therefore *not* a safety mechanism. Gate on `status.value === "loaded"`
   from the free `/models` call before ever issuing the request — measured
   24 ms warm, and it means the plugin never causes a load it did not need.
5. **`chat_template_caps` is the tool-calling answer.** There is no static field
   for it; function calling depends on the chat template plus `--jinja`, and
   `/props` reports that dependency already resolved. Probe only the model in
   active use, cache per model id (it is static), and promote `true` only —
   never demote a value the user set deliberately.

```ts
// Dump what the server really returns before writing the mapping.
const res = await fetch(`${baseURL}/v1/models`)
console.log(JSON.stringify((await res.json()).data[0], null, 2))
```

## RPC

```ts
import { Rpc } from "@opencode/plugin/rpc"   // canonical; "@opencode/plugin" also re-exports it

export const Acme = Rpc.define({
  id: "acme",
  methods: { search: { input: <schema>, output: <schema> } },
  events: { updated: { schema: { type: "object", additionalProperties: false } } },
})
```

Schemas may be JSON Schema (typed `unknown` — narrow it) or any **Standard
Schema** validator (Zod/Valibot/ArkType), which infers types.

```ts
const reg = await ctx.rpc.register(Acme, {
  search: async (input, context) => {
    /* context.signal, context.error(...) */
  },
});
const sub = ctx.rpc(Acme); // server-side call
const sub2 = ctx.client.rpc(Acme); // from a TUI plugin
```

**Make RPC total.** An `output` schema validates the handler's return value, so a
handler that throws fails the whole call (HTTP 500) and leaves the caller with no
state to render. Catch inside the handler and return an error-shaped value:

```ts
try {
  return await probe();
} catch (error) {
  return { status: "error", error: error instanceof Error ? error.message : String(error) };
}
```

And `catch` on the caller side too — an uncaught rejection is how a sidebar ends
up stuck on "loading…" forever instead of showing an error.

## TUI / CLI plugins

Separate entrypoint, separate context, separate registration.

```ts
// src/tui.tsx
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "acme.cli",
  setup(ctx) {
    return ctx.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <text fg={ctx.theme.text.base}>{sessionID}</text>,
    })
  },
})
```

Slot paths: `app`, `home.footer`, `home.footer.status`, `prompt.footer`,
`prompt.footer.status`, `prompt.footer.file`, `session.composer.top`,
`session.panel`, `sidebar.content`, `sidebar.footer`. Placement is exactly one of
`prepend` / `append` / `before` / `after` / `replace`.

Key differences from the server context:

- Events: `ctx.data.on(type, fn)` / `ctx.data.listen(({ details }) => …)` — both
  return an unsubscribe function. **Not** `ctx.event.subscribe`.
- Sessions: `ctx.data.session.get(id)`, `.message.list(id)`, plus `sync`/`invalidate`.
- Toasts: `ctx.ui.toast.show({ message, variant, duration })`.
- Colors: `ctx.theme.text.base` / `.muted`. `fg` takes `string | RGBA` — there
  are no semantic color _names_, resolve one from the theme.
- Storage: `ctx.storage.store(key, { initial })` → `[store, update]`; `.memory()`
  for state that should die with the TUI.
- Inside JSX, `usePlugin()` from `@opencode/plugin/tui` gives you the context.

### The `@opentui/solid` trap

`@opencode/plugin` peer-depends on `@opentui/solid >= 0.5.x`. In 0.5+ the old
imperative API (`createElement` / `setProp` / `insert`) **is gone**. Sidebar
rendering must use JSX:

```jsonc
// tsconfig.json
{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "@opentui/solid" } }
```

Pinning an older `@opentui/solid` fails `npm install` with `ERESOLVE` against the
peer range. For published packages the docs recommend
`@opentui/core` / `@opentui/solid` / `solid-js` as **peerDependencies**.

## Config layout on this machine

| What           | Where                                                         |
| -------------- | ------------------------------------------------------------- |
| Server plugins | `C:\Users\Joseph\.config\opencode\opencode.jsonc` → `plugins` |
| TUI plugins    | `C:\Users\Joseph\.config\opencode\tui.json` → `plugin`        |
| Server log     | `C:\Users\Joseph\.local\share\opencode\log\opencode.log`      |

Two things to watch:

- The key is **`plugins`** (plural) in V2; `plugin` (singular) is V1.
- The docs specify **`cli.json`** with `plugins` for CLI/TUI plugins. An existing
  `tui.json` with `plugin` still loads today, but it is a V1-era config and a
  reasonable thing to migrate.

A plugin entry that is a **directory** resolves to its `index.ts`, not `dist/`,
so the source is loaded directly and `dist` only matters for `./tui`, subpath
exports, and the `bin` CLI.

### A directory entry needs a real root `index.ts`

The resolution above is a plain `<dir>/index.ts` lookup. It does **not** consult
your `package.json` `main` / `exports`. So a repo whose entrypoint is
`src/index.ts` is **skipped silently** — no error, no warning, no log line, and
nothing in `opencode plugin list`.

```ts
// index.ts  ← must exist at the plugin root
export { MyPlugin } from "./src/index"
export { default } from "./src/index"
```

If a plugin "isn't showing up", check this before anything else. `opencode plugin
list` prints the resolved `SOURCE` path for the plugins that _did_ load — compare
it against your own layout and the mismatch is obvious.

## Verification

```bash
opencode plugin list          # NB: `opencode list plugins` does not exist
```

Confirm the id **and** source appear. Two caveats:

- Right after `opencode reload` this command transiently reports
  `No plugins found` — re-run it a second later before believing it.
- `opencode reload` is enough to pick up source changes; a full restart is not
  required for a plugin already listed.

Then in the log, confirm a `loading plugin … entrypoint=…` line with **no**
following `failed to load plugin` for that target. Absence of that first line
means the plugin never loaded at all (see the `index.ts` trap above); presence of
it with no failure means it loaded but may still be doing nothing (see the
`update`-cannot-create trap). `npm run build && npm test` locally, and exercise
every hook/transform/tool by hand — a plugin that loads is not a plugin that
works.

A Bun one-liner that mirrors the loader is a fast smoke test:

```bash
bun -e 'const m = await import("file:///abs/path/index.ts");
        const d = m.default;
        console.log(typeof d, d?.id, typeof d?.setup);'
```

Expect `object <id> function`.
