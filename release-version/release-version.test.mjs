import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { expect } from '../lib/expect.mjs'
import { decide, disagreement, earlierVersion, versionOf } from './release-version.mjs'

describe('versionOf', () => {
  it('is the trimmed version of a manifest', () => {
    expect(versionOf('{"name":"x","version":" 1.2.3 "}', 'package.json')).toBe('1.2.3')
  })

  it('names the file when the text is not JSON, or has no version, or an empty or non-string one', () => {
    expect(() => versionOf('{', 'package.json')).toThrow('package.json is not JSON.')
    expect(() => versionOf('{"name":"x"}', 'plugin.json')).toThrow('plugin.json has no version.')
    expect(() => versionOf('{"version":" "}', 'a.json')).toThrow('a.json has no version.')
    expect(() => versionOf('{"version":3}', 'a.json')).toThrow('a.json has no version.')
    expect(() => versionOf('null', 'a.json')).toThrow('a.json has no version.')
  })
})

describe('earlierVersion', () => {
  it('is the version a manifest had at the earlier commit', () => {
    expect(earlierVersion('{"version":"1.0.0"}')).toBe('1.0.0')
  })

  it('is undefined, not an error, when the manifest then was not JSON or had no version, so the tag decides', () => {
    expect(earlierVersion('{"name":"x"}')).toBe(undefined)
    expect(earlierVersion('not json')).toBe(undefined)
    expect(earlierVersion('')).toBe(undefined)
  })
})

describe('disagreement', () => {
  it('is null for files that agree, for one file and for none', () => {
    expect(disagreement({ 'package.json': '1.0.0', 'plugin.json': '1.0.0' })).toBeNull()
    expect(disagreement({ 'package.json': '1.0.0' })).toBeNull()
    expect(disagreement({})).toBeNull()
  })

  it('names each file and its version when they differ', () => {
    expect(disagreement({ 'package.json': '0.3.4', 'plugin.json': '0.3.3' })).toBe('package.json says 0.3.4 but plugin.json says 0.3.3: they must agree.')
  })
})

describe('decide', () => {
  const tag = 'v1.1.0'

  it('releases a version that changed in this push and has no tag', () => {
    expect(decide({ version: '1.1.0', before: '1.0.0', tagExists: false, tag })).toMatchObject({ release: true, reason: 'The version went from 1.0.0 to 1.1.0 and v1.1.0 has no tag.' })
  })

  it('does not release a version whose tag exists, even when it changed in this push', () => {
    expect(decide({ version: '1.1.0', before: '1.0.0', tagExists: true, tag })).toMatchObject({ release: false, reason: 'v1.1.0 already exists: nothing to release.' })
  })

  it('does not release a version this push left as it was, though no tag names it', () => {
    expect(decide({ version: '1.1.0', before: '1.1.0', tagExists: false, tag })).toMatchObject({ release: false, reason: 'The version is still 1.1.0: nothing to release.' })
  })

  it('lets the tag decide when there is no earlier version to compare with', () => {
    expect(decide({ version: '1.1.0', before: undefined, tagExists: false, tag }).release).toBe(true)
    expect(decide({ version: '1.1.0', before: undefined, tagExists: true, tag }).release).toBe(false)
  })

  it('releases nothing when the remote could not be asked, whatever else is known', () => {
    expect(decide({ version: '1.1.0', before: '1.0.0', tagExists: undefined, tag })).toMatchObject({ release: false, reason: 'Could not tell whether v1.1.0 exists, so nothing is released.' })
    expect(decide({ version: '1.1.0', before: undefined, tagExists: undefined, tag }).release).toBe(false)
  })
})

describe('action.yml', () => {
  it('holds no ${{ }} expression: the runner evaluates one in a description, where github.* is not available, and refuses to load the action', () => {
    expect(readFileSync(new URL('./action.yml', import.meta.url), 'utf8')).not.toContain('${{')
  })
})
