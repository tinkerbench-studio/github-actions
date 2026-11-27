import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { expect } from '../lib/expect.mjs'
import { parseCopies } from '../lib/version-copies.mjs'
import { mergedLabels, partFor, plan } from './raise.mjs'

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

describe('plan over the paths a repository names', () => {
  const paths = ['/src/**', '/package.json', '/plugin/**']

  for (const touched of ['src/cli.ts', 'package.json', 'plugin/.claude-plugin/plugin.json']) {
    it(`raises the patch when the merge touched ${touched}`, () => {
      expect(plan({ changed: ['README.md', touched], paths, copies: copies() })).toMatchObject({ raised: true, version: '1.4.3' })
    })
  }

  it('raises nothing when the merge touched none of them', () => {
    expect(plan({ changed: ['README.md', 'docs/src/a.ts', 'tests/package.json'], paths, copies: copies() }).raised).toBe(false)
  })
})

describe('a second manifest, raised in the same run by a step of its own', () => {
  const manifest = version => parseCopies('plugin/.claude-plugin/plugin.json').map(copy => ({ ...copy, text: `{ "name": "p", "version": "${version}" }\n` }))
  // As a release job runs them: the package for any of its paths, the plugin for its own only.
  const run = changed => ({
    package: plan({ changed, paths: ['/src/**', '/package.json', '/plugin/**'], copies: copies() }),
    plugin: plan({ changed, paths: ['/plugin/**'], copies: manifest('0.6.4') }),
  })

  it('raises the plugin manifest too when the merge touched its path', () => {
    const { package: pkg, plugin } = run(['plugin/skills/a.md'])
    expect(pkg).toMatchObject({ raised: true, version: '1.4.3' })
    expect(plugin).toMatchObject({ raised: true, version: '0.6.5' })
    expect(plugin.edits).toEqual([{ file: 'plugin/.claude-plugin/plugin.json', text: '{ "name": "p", "version": "0.6.5" }\n' }])
  })

  it('leaves the plugin manifest as it was when the merge touched only the package', () => {
    const { package: pkg, plugin } = run(['src/cli.ts'])
    expect(pkg.raised).toBe(true)
    expect(plugin).toMatchObject({ raised: false, reason: 'The merge changed nothing under /plugin/**: the version stays 0.6.4.' })
    expect(plugin.edits).toBe(undefined)
  })
})

describe('partFor and the release: labels', () => {
  it('raises the patch with no release: label, and reads no other label', () => {
    expect(partFor({ labels: [] })).toBe('patch')
    expect(partFor({ labels: ['bug', 'released', 'ux'] })).toBe('patch')
  })

  it('raises the minor for release:minor and the major for release:major', () => {
    expect(partFor({ labels: ['bug', 'release:minor'] })).toBe('minor')
    expect(partFor({ labels: ['release:major'] })).toBe('major')
  })

  it('takes the larger part: major beats minor, and a label never lowers the part given', () => {
    expect(partFor({ labels: ['release:minor', 'release:major'] })).toBe('major')
    expect(partFor({ labels: ['release:major', 'release:minor'] })).toBe('major')
    expect(partFor({ part: 'major', labels: ['release:minor'] })).toBe('major')
    expect(partFor({ part: 'minor', labels: [] })).toBe('minor')
  })

  it('fails naming an unknown release: label, rather than raising the patch', () => {
    expect(() => partFor({ labels: ['release:patch'] })).toThrow('The pull request has the label "release:patch", which is not a release label: the known ones are release:minor and release:major.')
    expect(() => partFor({ labels: ['release:minor', 'release:Major'] })).toThrow('"release:Major"')
  })

  it('raises the part a label asks for through plan', () => {
    expect(plan({ changed: ['src/a.ts'], paths: ['**'], labels: ['release:minor'], copies: copies() })).toMatchObject({
      version: '1.5.0',
      reason: 'The merge changed src/a.ts: the minor version is raised from 1.4.2 to 1.5.0.',
    })
    expect(plan({ changed: ['src/a.ts'], paths: ['**'], labels: ['release:major'], copies: copies() }).version).toBe('2.0.0')
  })

  it('fails an unknown release: label through plan even when nothing would be raised', () => {
    expect(() => plan({ changed: ['README.md'], paths: ['/src/**'], labels: ['release:big'], copies: copies() })).toThrow('"release:big"')
  })
})

describe('mergedLabels', () => {
  const pull = (sha, labels, change = {}) => ({ merged_at: '2026-11-27T10:00:00Z', merge_commit_sha: sha, base: { ref: 'main' }, labels: labels.map(name => ({ name })), ...change })
  const answering = pulls => {
    const asked = []
    return { asked, get: async path => (asked.push(path), pulls) }
  }

  it('reads the labels of the pull request merged as the commit', async () => {
    const { asked, get } = answering([pull('abc', ['release:minor', 'bug'])])
    expect(await mergedLabels({ repository: 'o/r', sha: 'abc', branch: 'main' }, get)).toEqual(['release:minor', 'bug'])
    expect(asked).toEqual(['/repos/o/r/commits/abc/pulls?per_page=100'])
  })

  it('leaves out a pull request that is not merged, merged as another commit, or into another branch', async () => {
    const { get } = answering([
      pull('abc', ['release:major'], { merged_at: null }),
      pull('other', ['release:major']),
      pull('abc', ['release:major'], { base: { ref: 'next' } }),
      pull('abc', ['ux']),
    ])
    expect(await mergedLabels({ repository: 'o/r', sha: 'abc', branch: 'main' }, get)).toEqual(['ux'])
  })

  it('has no labels for a push that came from no pull request', async () => {
    expect(await mergedLabels({ repository: 'o/r', sha: 'abc', branch: 'main' }, answering([]).get)).toEqual([])
  })

  it('throws when GitHub cannot be asked', async () => {
    const get = async path => {
      throw new Error(`GET ${path} answered 403`)
    }
    let thrown
    try {
      await mergedLabels({ repository: 'o/r', sha: 'abc', branch: 'main' }, get)
    } catch (error) {
      thrown = error
    }
    expect(thrown?.message).toBe('GET /repos/o/r/commits/abc/pulls?per_page=100 answered 403')
  })
})

describe('action.yml', () => {
  it('holds no ${{ }} expression: the runner evaluates one in a description and refuses to load the action', () => {
    expect(readFileSync(new URL('./action.yml', import.meta.url), 'utf8')).not.toContain('${{')
  })
})
