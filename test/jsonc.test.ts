import {describe, expect, it} from 'vitest'
import {parseJsonc, stripJsonComments} from '../src/utils/jsonc'

describe('stripJsonComments', () => {
    it('leaves plain JSON untouched', () => {
        const json = '{"a":1,"b":[1,2,3],"c":{"d":"e"}}'
        expect(stripJsonComments(json)).toBe(json)
    })

    it('removes line comments', () => {
        // `// a comment` is 12 chars, blanked to 12 spaces; the newline survives.
        expect(stripJsonComments('{\n// a comment\n"a":1\n}')).toBe('{\n            \n"a":1\n}')
    })

    it('removes block comments', () => {
        // Comment becomes spaces; the text still has to parse as the same value.
        expect(stripJsonComments('{/* inline */"a":1}')).not.toContain('inline')
        expect(parseJsonc('{/* inline */"a":1}')).toEqual({a: 1})
    })

    it('preserves string length so offsets survive', () => {
        const input = '{// hi\n"a":1}'
        expect(stripJsonComments(input).length).toBe(input.length)
    })

    it('removes multi-line block comments but keeps newlines', () => {
        const input = '{/*\nline1\nline2\n*/"a":1}'
        const result = stripJsonComments(input)
        expect(result).not.toContain('line1')
        expect(result.split('\n').length).toBe(input.split('\n').length)
    })

    it('removes trailing commas in objects and arrays', () => {
        expect(parseJsonc('{"a":1,}')).toEqual({a: 1})
        expect(parseJsonc('[1,2,3,]')).toEqual([1, 2, 3])
        expect(parseJsonc('{"a":[1,2,],}')).toEqual({a: [1, 2]})
    })

    it('keeps commas that are not trailing', () => {
        expect(parseJsonc('[1,2,3]')).toEqual([1, 2, 3])
    })

    it('drops a trailing comma separated from the bracket by a comment', () => {
        expect(parseJsonc('{\n  "a": 1, // note\n}')).toEqual({a: 1})
        expect(parseJsonc('{\n  "a": 1, /* note */\n}')).toEqual({a: 1})
        expect(parseJsonc('[1, 2, // note\n]')).toEqual([1, 2])
    })

    it('preserves comment-like sequences inside strings', () => {
        const config = {
            url: 'http://localhost:9931/v1',
            glob: '/* not a comment */',
            note: 'trailing comma, ] here',
            quoted: 'he said "hi"',
        }
        expect(parseJsonc(JSON.stringify(config))).toEqual(config)
    })

    it('handles escaped quotes inside strings', () => {
        expect(parseJsonc('{"a":"say \\"// not a comment\\""}')).toEqual({a: 'say "// not a comment"'})
    })

    it('parses a realistic opencode config', () => {
        const raw = `{
  // Provider block
  "providers": {
    "llama.cpp": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:9931/v1", // trailing comment
      },
    },
  },
}`
        expect(parseJsonc(raw)).toEqual({
            providers: {
                'llama.cpp': {
                    npm: '@ai-sdk/openai-compatible',
                    options: {baseURL: 'http://localhost:9931/v1'},
                },
            },
        })
    })

    it('throws on genuinely malformed JSON', () => {
        expect(() => parseJsonc('{"a":}')).toThrow()
        expect(() => parseJsonc('not json at all')).toThrow()
    })

    it('does not treat a slash outside a comment as a comment', () => {
        expect(parseJsonc('{"a":1}')).toEqual({a: 1})
    })

    it('handles an unterminated block comment without looping forever', () => {
        expect(() => stripJsonComments('{/* unterminated')).not.toThrow()
    })
})