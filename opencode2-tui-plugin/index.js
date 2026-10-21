/**
 * Bridge for the OpenCode 2 TUI plugin resolver.
 *
 * The TUI loader is configured with a directory path, which would otherwise
 * resolve to this package's *server* entry (`index.ts`). This shim points it at
 * the TUI entry so `~/.config/opencode/tui.json` can register the toast plugin:
 *
 *   { "plugin": ["<path>/opencode2-tui-plugin"] }
 *
 * The TUI plugin is a separate plugin type (`@opencode/plugin/tui`) running in a
 * different process, so it cannot simply be re-exported from the server entry.
 */
export {default} from '../src/tui.ts'