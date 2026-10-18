# Showing command output in the TUI

## The problem

A plugin command's `execute` returns `Effect<void>`:

```ts
interface CommandDefinition {
    readonly name: string
    readonly description?: string
    readonly execute: (input: CommandInvocation) => Effect.Effect<void, unknown>
}
```

There is no return channel to the interface, so `console.log` from a command goes to the
OpenCode log file and nowhere the user can see it.

## Why `session.synthetic` is the wrong fix

The obvious workaround is to inject a synthetic message:

```ts
await ctx.session.synthetic({sessionID, text, delivery: 'steer'})
```

This is actively harmful. From OpenCode's inbox spec (`specs/v2/session.md`):

> `steer` is the default. Steers deliver in enqueue order at the next Safe Step Boundary.

and

> The `session.inbox.delivered` projection consumes the row and inserts a visible user or
> synthetic message atomically.

`steer` therefore does not mean "keep this out of the model's way" — it means "hand this to
the running model at its next step boundary". The message lands in **model-visible Session
History**, so running `/llamacpp-refresh` mid-turn would feed the model a line like
`catalog updated — 17 models` and steer what it does next.

`queue` is not an escape either: it only defers the same insertion to an idle boundary, so the
text still ends up in history.

**Rule: never use `session.synthetic` for status output.** It is for content the user intends
the model to see.

## The correct fix: a TUI plugin

OpenCode has a second plugin flavour, `@opencode/plugin/tui`, which runs in the TUI process
and exposes UI primitives including toasts:

```ts
import {Plugin} from '@opencode/plugin/tui'

export default Plugin.define({
    id: 'opencode-llama-cpp-tui',
    setup(ctx) {
        ctx.ui.toast.show({
            title: 'llama.cpp',
            message: 'catalog updated — 17 models',
            variant: 'info',      // info | success | warning | error
            duration: 4000,
        })
    },
})
```

TUI plugins are registered separately, in `~/.config/opencode/tui.json` (note: `plugin`, not
`plugins`):

```json
{
  "plugin": ["<path-to-tui-plugin>"]
}
```

Because the loader resolves a directory to the package's *server* entry, a TUI plugin needs a
small shim directory pointing at the TUI build:

```
opencode2-tui-plugin/
  package.json   { "type": "module", "main": "index.js" }
  index.js       export {default} from "../dist/tui.js"
```

## Getting data across the process boundary

Server plugins and TUI plugins are different processes, so a toast cannot simply ask the server
plugin what happened. Use RPC, which OpenCode provides for exactly this:

- **Server side** — register a definition and handlers:
  ```ts
  const registration = await ctx.rpc.register(DEFINITION, {
      refresh: async () => { /* … */ },
  })
  // and notify the TUI:
  await registration.events.emit({type: 'result', …})
  ```
- **TUI side** — call the method, then toast the returned value.

This is the pattern `opencode-codex-usagex` already uses, with its `CODEX_USAGE_RPC`
definition shared between `index.ts` and `tui.ts`.

## Interim behaviour

Until a TUI plugin exists, `/llamacpp-refresh` and `/llamacpp-unload` log their result:

```bash
grep "llama.cpp" ~/.local/share/opencode/log/opencode.log | tail
```

or run `pnpm run doctor`, which prints the same information to the terminal.