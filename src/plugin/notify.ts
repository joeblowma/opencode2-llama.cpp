import {log} from '../utils/log'

/**
 * Report command results to the log.
 *
 * **Deliberately does not use `ctx.session.synthetic`.**
 *
 * A command's `execute` returns `Effect<void>` — there is no return channel to
 * the interface — so the tempting way to surface output is to inject a synthetic
 * session message. That is wrong, and measurably so:
 *
 * OpenCode's inbox spec defines `delivery: 'steer'` as the *default* mode: the
 * item delivers at the next Safe Step Boundary and its projection inserts a
 * visible synthetic message into **model-visible Session History**. Running a
 * refresh mid-turn would therefore hand the running model a line of status text
 * and steer its next step. `queue` is no better — it merely defers the same
 * insertion to an idle boundary.
 *
 * Status output belongs to the human, so from a server plugin the log is the
 * only correct channel. Surfacing it in the TUI requires a TUI plugin, which
 * runs in a separate process and can use `ctx.ui.toast`.
 */
export async function report(text: string, level: 'info' | 'warn' = 'info'): Promise<void> {
    if (level === 'warn') {
        log.warn(text)
    } else {
        log.info(text)
    }
}

export type ReportLevel = 'info' | 'warn'