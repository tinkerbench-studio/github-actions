import { describe, it } from 'node:test'

import { flag, input, oneLine, outputLines } from './actions.mjs'
import { expect } from './expect.mjs'
import { reader } from './github.mjs'
import { matchesAny, matchesGlob } from './glob.mjs'

describe('actions', () => {
  it('reads an input as the runner names it, trimmed, and empty when it was not given', () => {
    expect(input('pull-request-files', { 'INPUT_PULL-REQUEST-FILES': ' files.json \n' })).toBe('files.json')
    expect(input('two words', { INPUT_TWO_WORDS: 'x' })).toBe('x')
    expect(input('missing', {})).toBe('')
  })

  it('reads true and false, and falls back on anything else', () => {
    expect(flag('a', false, { INPUT_A: 'TRUE' })).toBe(true)
    expect(flag('a', true, { INPUT_A: 'false' })).toBe(false)
    expect(flag('a', true, { INPUT_A: 'yes' })).toBe(true)
    expect(flag('a', false, {})).toBe(false)
  })

  it('writes each output between a delimiter of its own, so a value with a newline cannot set another output', () => {
    let n = 0
    expect(outputLines({ a: 'one', b: 'two\nc=three' }, () => `d${++n}`)).toBe('a<<d1\none\nd1\nb<<d2\ntwo\nc=three\nd2\n')
  })

  it('puts a workflow command’s text on one line', () => {
    expect(oneLine('a\nb\r\nc')).toBe('a b c')
  })
})

describe('reader', () => {
  it('sends the token and returns the parsed answer', async () => {
    const calls = []
    const get = async (url, options) => {
      calls.push([url, options.headers.authorization])
      return { ok: true, json: async () => ({ a: 1 }) }
    }
    expect(await reader({ api: 'https://api.test', token: 't', get })('/repos/o/r')).toEqual({ a: 1 })
    expect(calls).toEqual([['https://api.test/repos/o/r', 'Bearer t']])
  })

  it('throws, naming the path and the status, when GitHub does not answer 2xx, and at once without a token', async () => {
    const get = async () => ({ ok: false, status: 403 })
    let message
    await reader({ token: 't', get })('/repos/o/r').catch(error => (message = error.message))
    expect(message).toBe('GET /repos/o/r answered 403')
    expect(() => reader({ token: '' })).toThrow('no token to read GitHub with')
  })
})

describe('matchesGlob', () => {
  it('* stays inside a path segment; ** crosses them; ? is one character', () => {
    expect(matchesGlob('docs/a.md', '/docs/*')).toBe(true)
    expect(matchesGlob('docs/a/b.md', '/docs/*')).toBe(false)
    expect(matchesGlob('docs/a/b.md', '/docs/**')).toBe(true)
    expect(matchesGlob('a1.ts', '/a?.ts')).toBe(true)
    expect(matchesGlob('a/1.ts', '/a?1.ts')).toBe(false)
  })

  it('**/ also matches no directory', () => {
    expect(matchesGlob('docs/x.test.ts', '/docs/**/*.test.ts')).toBe(true)
    expect(matchesGlob('docs/a/b/x.test.ts', '/docs/**/*.test.ts')).toBe(true)
  })

  it('matches at any depth unless it starts with /', () => {
    expect(matchesGlob('packages/a/README.md', '*.md')).toBe(true)
    expect(matchesGlob('packages/docs/a.ts', 'docs/**')).toBe(true)
    expect(matchesGlob('packages/docs/a.ts', '/docs/**')).toBe(false)
  })

  it('reads every other character as itself', () => {
    expect(matchesGlob('package.json', '/package.json')).toBe(true)
    expect(matchesGlob('packageXjson', '/package.json')).toBe(false)
    expect(matchesGlob('a(1)+[2].ts', '/a(1)+[2].ts')).toBe(true)
  })

  it('matchesAny is true when one glob matches, and false for no globs', () => {
    expect(matchesAny('a.md', ['/docs/**', '*.md'])).toBe(true)
    expect(matchesAny('a.md', [])).toBe(false)
  })
})
