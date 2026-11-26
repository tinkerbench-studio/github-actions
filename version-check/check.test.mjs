import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { expect } from '../lib/expect.mjs'
import { parseCopies } from '../lib/version-copies.mjs'
import { check } from './check.mjs'

const manifest = version => `{ "name": "x", "version": "${version}" }`
const state = version => `export const VERSION = '${version}'\n`
const copies = ({ base = ['1.0.0', '1.0.0'], head = ['1.0.0', '1.0.0'] } = {}) =>
  parseCopies("package.json\nsrc/state.ts VERSION = '([^']+)'").map((copy, i) => {
    const text = i === 0 ? manifest : state
    return { ...copy, base: base[i] === null ? null : text(base[i]), head: text(head[i]) }
  })

describe('check', () => {
  it('passes a pull request that left every copy as it was', () => {
    expect(check({ copies: copies() })).toEqual({ ok: true, reason: 'The version is 1.0.0, as on the base.' })
  })

  it('fails a pull request that raised the version, naming each copy it changed', () => {
    const result = check({ copies: copies({ head: ['1.1.0', '1.1.0'] }) })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('This pull request changes the version (package.json from 1.0.0 to 1.1.0, src/state.ts from 1.0.0 to 1.1.0). Leave it as it was: it is raised after the merge.')
  })

  it('throws when the copies disagree now, rather than comparing them one by one', () => {
    expect(() => check({ copies: copies({ head: ['1.1.0', '1.0.0'] }) })).toThrow('they must agree')
  })

  it('passes a copy the base did not have, or held in another form: the pull request is adding it', () => {
    expect(check({ copies: copies({ base: ['1.0.0', null] }) }).ok).toBe(true)
    const added = copies()
    added[1].base = 'export const OTHER = 1\n'
    expect(check({ copies: added }).ok).toBe(true)
  })

  it('throws when a copy cannot be read now', () => {
    const broken = copies()
    broken[0].head = '{'
    expect(() => check({ copies: broken })).toThrow('package.json is not JSON.')
  })
})

describe('action.yml', () => {
  it('holds no ${{ }} expression: the runner evaluates one in a description and refuses to load the action', () => {
    expect(readFileSync(new URL('./action.yml', import.meta.url), 'utf8')).not.toContain('${{')
  })
})
