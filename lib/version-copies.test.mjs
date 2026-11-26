import { describe, it } from 'node:test'

import { expect } from './expect.mjs'
import { agreed, locate, nextVersion, parseCopies, rewrite } from './version-copies.mjs'

describe('parseCopies', () => {
  it('reads a path alone as a JSON manifest and a path with a pattern as any other file, skipping blank lines', () => {
    const copies = parseCopies("package.json\n\n  hooks/state.ts   MOD_VERSION = '([^']+)'  \n")
    expect(copies).toHaveLength(2)
    expect(copies[0]).toEqual({ file: 'package.json', pattern: null })
    expect(copies[1].file).toBe('hooks/state.ts')
    expect(copies[1].pattern.source).toBe("MOD_VERSION = '([^']+)'")
  })

  it('refuses a pattern with no capture group, or more than one, naming the line', () => {
    expect(() => parseCopies('a.ts VERSION = 1')).toThrow('The copy "a.ts VERSION = 1" needs a pattern with exactly one capture group')
    expect(() => parseCopies("a.ts (V) = '([^']+)'")).toThrow('exactly one capture group')
  })

  it('counts only capturing groups', () => {
    expect(parseCopies("a.ts (?:V|W) = '([^']+)'")[0].file).toBe('a.ts')
  })

  it('refuses a pattern that is not a regular expression, and an input naming no copy', () => {
    expect(() => parseCopies('a.ts ([')).toThrow('not a regular expression')
    expect(() => parseCopies('\n  \n')).toThrow('No copies of the version are named')
  })
})

describe('locate', () => {
  const json = { file: 'package.json', pattern: null }

  it("finds a manifest's top-level version, not a nested one with another value", () => {
    const text = '{\n  "name": "x",\n  "engines": { "version": "9.9.9" },\n  "version": "1.2.3"\n}\n'
    const { version, start, end } = locate(json, text)
    expect(version).toBe('1.2.3')
    expect(text.slice(start, end)).toBe('1.2.3')
  })

  it('refuses a manifest that is not JSON, has no version, or holds its version string twice', () => {
    expect(() => locate(json, '{')).toThrow('package.json is not JSON.')
    expect(() => locate(json, '{"name":"x"}')).toThrow('package.json has no version.')
    expect(() => locate(json, '{"a":{"version":"1.0.0"},"version":"1.0.0"}')).toThrow('more than once')
  })

  it("finds a pattern's capture, and refuses a pattern that matches no time or twice", () => {
    const copy = parseCopies("state.ts MOD_VERSION = '([^']+)'")[0]
    const text = "export const MOD_VERSION = '0.50.3'\n"
    const { version, start, end } = locate(copy, text)
    expect(version).toBe('0.50.3')
    expect(text.slice(start, end)).toBe('0.50.3')
    expect(() => locate(copy, 'nothing')).toThrow('state.ts matches')
    expect(() => locate(copy, `${text}${text}`)).toThrow('2 times; it must match once')
  })
})

describe('agreed', () => {
  it('is the one version every copy holds', () => {
    expect(agreed({ 'package.json': '1.0.0', 'plugin.json': '1.0.0' })).toBe('1.0.0')
  })

  it('names each copy when they differ', () => {
    expect(() => agreed({ 'package.json': '0.3.4', 'plugin.json': '0.3.3' })).toThrow('package.json says 0.3.4 but plugin.json says 0.3.3: they must agree.')
  })
})

describe('nextVersion', () => {
  it('raises the part asked for, the patch when none is', () => {
    expect(nextVersion('1.4.9')).toBe('1.4.10')
    expect(nextVersion('1.4.9', 'minor')).toBe('1.5.0')
    expect(nextVersion('1.4.9', 'major')).toBe('2.0.0')
  })

  it('refuses an unknown part and a version that is not major.minor.patch', () => {
    expect(() => nextVersion('1.0.0', 'build')).toThrow('"build" is not a part of a version')
    expect(() => nextVersion('1.0.0-beta.1')).toThrow('is not a version of the form major.minor.patch')
    expect(() => nextVersion('1.0')).toThrow('major.minor.patch')
  })
})

describe('rewrite', () => {
  it('replaces the version and leaves the rest of the file byte for byte', () => {
    const text = '{\n  "name": "x",\n  "version": "1.2.3",\n  "private": true\n}\n'
    expect(rewrite({ file: 'package.json', pattern: null }, text, '1.2.4')).toBe(text.replace('1.2.3', '1.2.4'))
    const copy = parseCopies('f.json "modVersion": "([^"]+)"')[0]
    expect(rewrite(copy, '{ "a": 1, "modVersion": "0.1.0" }', '0.1.1')).toBe('{ "a": 1, "modVersion": "0.1.1" }')
  })
})
