// OpenCode resolves a plugin entry that is a *directory* to `<dir>/index.ts`.
// This re-export is what makes the directory entry in opencode.json work; the
// real implementation lives in src/.
export {LlamaCppPlugin} from './src/index'
export {default} from './src/index'