/**
 * Minimal JSONC reader for OpenCode config files.
 *
 * OpenCode accepts `.jsonc`, so config files carry `//` and block comments plus
 * trailing commas. This parses that subset directly instead of pulling in a
 * runtime dependency, which keeps the plugin's load surface to the SDK alone.
 *
 * Two string-aware passes, so comment markers and commas that appear inside
 * string values are never mistaken for syntax:
 *
 *   1. Comments are replaced with spaces, byte-for-byte, so offsets and line
 *      numbers survive and any downstream `JSON.parse` error still points at
 *      the right place in the original file.
 *   2. Commas followed only by whitespace before `}` or `]` are dropped.
 *
 * Splitting it this way matters for correctness: a comma can be followed by a
 * comment before the closing bracket (`"a": 1, // note\n}`), which a
 * single-pass scanner cannot see without re-implementing comment skipping
 * inside the lookahead.
 */

/** Replace JSONC comments with spaces, preserving length and newlines. */
function blankComments(input: string): string {
    const out = input.split('')

    let i = 0
    while (i < input.length) {
        const ch = input[i]
        const next = input[i + 1]

        if (ch === '/' && next === '/') {
            // Line comment: blank to the newline, leave the newline itself intact.
            while (i < input.length && input[i] !== '\n') {
                out[i] = ' '
                i++
            }
            continue
        }

        if (ch === '/' && next === '*') {
            // Block comment: blank to the terminator, keep newlines for line numbering.
            while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
                if (input[i] !== '\n') out[i] = ' '
                i++
            }
            // Blank the closing `*/` if it was present.
            if (i < input.length) {
                out[i] = ' '
                out[i + 1] = ' '
                i += 2
            }
            continue
        }

        if (ch === '"') {
            // String literal: skip past it whole so comment markers inside values
            // are not blanked. Escaped quotes are consumed in pairs.
            i++
            while (i < input.length) {
                if (input[i] === '\\') {
                    i += 2
                    continue
                }
                if (input[i] === '"') {
                    i++
                    break
                }
                i++
            }
            continue
        }

        i++
    }

    return out.join('')
}

/** Drop commas that are followed only by whitespace before `}` or `]`. */
function dropTrailingCommas(input: string): string {
    const out = input.split('')

    let i = 0
    while (i < out.length) {
        // Skip string literals so a value like "a, ]" keeps its comma.
        if (input[i] === '"') {
            i++
            while (i < out.length) {
                if (input[i] === '\\') {
                    i += 2
                    continue
                }
                if (input[i] === '"') {
                    i++
                    break
                }
                i++
            }
            continue
        }

        if (input[i] === ',') {
            let j = i + 1
            while (j < out.length && /\s/.test(out[j])) j++
            if (out[j] === '}' || out[j] === ']') out[i] = ' '
        }

        i++
    }

    return out.join('')
}

/**
 * Strip comments and trailing commas from a JSONC document.
 *
 * Exported for tests and for callers that want the cleaned text; `parseJsonc`
 * covers normal use.
 */
export function stripJsonComments(input: string): string {
    return dropTrailingCommas(blankComments(input))
}

/**
 * Parse a JSONC document into plain JSON.
 *
 * @throws SyntaxError if the input is not valid JSON after cleaning, propagating
 * the `JSON.parse` message.
 */
export function parseJsonc<T = unknown>(input: string): T {
    return JSON.parse(stripJsonComments(input)) as T
}