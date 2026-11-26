import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { expect } from '../lib/expect.mjs'
import { parseCopies } from '../lib/version-copies.mjs'
import { plan } from './raise.mjs'

const copies = (pkg = '1.4.2', state = '1.4.2') =>
  parseCopies("package.json\nsrc/state.ts VERSION = '([^']+)'").map(copy => ({
    ...copy,
    text: copy.pattern === null ? `{\n  "name": "x",\n  "version": "${pkg}"\n}\n` : `export const VERSION = '${state}'\n`,
  }))

describe('plan', () => {
  it('raises every copy when the merge changed a path named, and says which', () => {
    const result = plan({ changed: ['README.md', 'src/cli.ts'], paths: ['src/**', 'plugin/**'], copies: copies() })
    expect(result).toMatchObject({ raised: true, previous: '1.4.2', version: '1.4.3', reason: 'The merge changed src/cli.ts: the patch version is raised from 1.4.2 to 1.4.3.' })
    expect(result.edits).toEqual([
      { file: 'package.json', text: '{\n  "name": "x",\n  "version": "1.4.3"\n}\n' },
      { file: 'src/state.ts', text: "export const VERSION = '1.4.3'\n" },
    ])
  })

  it('reads a glob that starts with / from the top of the repository only', () => {
    expect(plan({ changed: ['docs/src/a.ts'], paths: ['/src/**'], copies: copies() }).raised).toBe(false)
    expect(plan({ changed: ['src/a.ts'], paths: ['/src/**'], copies: copies() }).raised).toBe(true)
  })

  it('counts the other changed paths in the reason', () => {
    expect(plan({ changed: ['src/a.ts', 'src/b.ts', 'src/c.ts'], paths: ['src/**'], copies: copies() }).reason).toContain('src/a.ts and 2 more')
  })

  it('raises the minor or the major when asked', () => {
    expect(plan({ changed: ['src/a.ts'], paths: ['**'], part: 'minor', copies: copies() }).version).toBe('1.5.0')
    expect(plan({ changed: ['src/a.ts'], paths: ['**'], part: 'major', copies: copies() }).version).toBe('2.0.0')
  })

  it('raises nothing when the merge changed no path named, and writes nothing', () => {
    const result = plan({ changed: ['README.md', 'docs/a.md'], paths: ['src/**'], copies: copies() })
    expect(result).toMatchObject({ raised: false, reason: 'The merge changed nothing under src/**: the version stays 1.4.2.' })
    expect(result.edits).toBe(undefined)
    expect(plan({ changed: [], paths: ['**'], copies: copies() }).raised).toBe(false)
  })

  it('raises nothing when the changed files could not be listed, and says so', () => {
    expect(plan({ changed: null, paths: ['**'], copies: copies() })).toMatchObject({ raised: false, reason: 'Could not list the files the merge changed, so the version is not raised.' })
  })

  it('throws before deciding anything when the copies disagree, even when nothing would be raised', () => {
    expect(() => plan({ changed: ['src/a.ts'], paths: ['**'], copies: copies('1.4.2', '1.4.1') })).toThrow('package.json says 1.4.2 but src/state.ts says 1.4.1: they must agree.')
    expect(() => plan({ changed: null, paths: ['**'], copies: copies('1.4.2', '1.4.1') })).toThrow('they must agree')
  })

  it('throws for an unknown part rather than raising the patch', () => {
    expect(() => plan({ changed: ['src/a.ts'], paths: ['**'], part: 'build', copies: copies() })).toThrow('"build" is not a part of a version')
  })
})

describe('action.yml', () => {
  it('holds no ${{ }} expression: the runner evaluates one in a description and refuses to load the action', () => {
    expect(readFileSync(new URL('./action.yml', import.meta.url), 'utf8')).not.toContain('${{')
  })
})
