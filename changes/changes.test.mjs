import { describe, it } from 'node:test'

import { expect } from '../lib/expect.mjs'
import { answer, answers, changedFiles, parseConfig } from './changes.mjs'

const CONFIG = JSON.stringify({
  outputs: {
    docs_only: { every: ['/docs/**', '*.md', '/.claude/**'], except: ['/docs/**/*.test.ts'] },
    storybook: { any: ['/stories/**', '/components/**'] },
  },
})

describe('parseConfig', () => {
  it('reads each question, and answers an unlisted change with the answer that runs the work', () => {
    expect(parseConfig(CONFIG)).toEqual([
      { name: 'docs_only', kind: 'every', globs: ['/docs/**', '*.md', '/.claude/**'], except: ['/docs/**/*.test.ts'], unlisted: false },
      { name: 'storybook', kind: 'any', globs: ['/stories/**', '/components/**'], except: [], unlisted: true },
    ])
  })

  it('lets a question set its own answer for an unlisted change', () => {
    expect(parseConfig('{"outputs":{"deploys":{"any":["/src/**"],"unlisted":false}}}')[0].unlisted).toBe(false)
  })

  it('refuses a config it cannot read, naming what is wrong', () => {
    expect(() => parseConfig('{')).toThrow('the config is not JSON')
    expect(() => parseConfig('{}')).toThrow('the config needs an "outputs" object')
    expect(() => parseConfig('{"outputs":{"Docs":{"any":["a"]}}}')).toThrow("Docs cannot be an output's name")
    expect(() => parseConfig('{"outputs":{"listed":{"any":["a"]}}}')).toThrow("listed cannot be an output's name")
    expect(() => parseConfig('{"outputs":{"a":{"any":["x"],"every":["y"]}}}')).toThrow('a needs exactly one of "every" and "any"')
    expect(() => parseConfig('{"outputs":{"a":{}}}')).toThrow('a needs exactly one of "every" and "any"')
    expect(() => parseConfig('{"outputs":{"a":{"any":[]}}}')).toThrow('a.any must name at least one glob')
    expect(() => parseConfig('{"outputs":{"a":{"any":"x"}}}')).toThrow('a.any must be a list of globs')
    expect(() => parseConfig('{"outputs":{"a":{"any":["x"],"except":[1]}}}')).toThrow('a.except must be a list of globs')
    expect(() => parseConfig('{"outputs":{"a":{"any":["x"],"unlisted":"yes"}}}')).toThrow('a.unlisted must be true or false')
  })
})

describe('answers', () => {
  const [docsOnly, storybook] = parseConfig(CONFIG)

  it('every: true only when each file matches', () => {
    expect(answer(docsOnly, ['docs/a.md', 'README.md', '.claude/skills/x/SKILL.md'])).toBe(true)
    expect(answer(docsOnly, ['docs/a.md', 'src/a.ts'])).toBe(false)
  })

  it('every: a file an except glob matches does not count as matching', () => {
    expect(answer(docsOnly, ['docs/a.md', 'docs/links.test.ts'])).toBe(false)
  })

  it('any: true when one file matches, and not for a file an except glob matches', () => {
    expect(answer(storybook, ['src/a.ts', 'stories/button.stories.tsx'])).toBe(true)
    expect(answer(storybook, ['src/a.ts'])).toBe(false)
    expect(answer({ ...storybook, except: ['*.md'] }, ['stories/README.md'])).toBe(false)
  })

  it('an anchored glob matches only from the root; an unanchored one at any depth', () => {
    expect(answer(docsOnly, ['packages/x/docs/a.ts'])).toBe(false)
    expect(answer(docsOnly, ['packages/x/NOTES.md'])).toBe(true)
  })

  it('never guesses at a change that could not be listed or lists nothing: nothing is skipped', () => {
    for (const files of [null, []]) expect(answers([docsOnly, storybook], files)).toEqual({ docs_only: false, storybook: true })
  })
})

describe('changedFiles', () => {
  const git = out => {
    const run = (args, cwd) => {
      run.calls.push({ args, cwd })
      return out
    }
    run.calls = []
    return run
  }

  it('lists the files changed since the merge base with base', () => {
    const run = git('a.ts\ndocs/b.md\n')
    expect(changedFiles({ base: 'origin/main', cwd: '/w' }, run)).toEqual(['a.ts', 'docs/b.md'])
    expect(run.calls).toEqual([{ args: ['diff', '--name-only', '--no-renames', 'origin/main...HEAD'], cwd: '/w' }])
  })

  it('compares a merge commit with its first parent when asked, and base wins when both are given', () => {
    const run = git('a.ts\n')
    changedFiles({ firstParent: true, cwd: '/w' }, run)
    changedFiles({ base: 'origin/main', firstParent: true, cwd: '/w' }, run)
    expect(run.calls.map(call => call.args.slice(3))).toEqual([['HEAD^1', 'HEAD'], ['origin/main...HEAD']])
  })

  it('is null, not an empty list, when nothing says what to compare with or git fails', () => {
    expect(changedFiles({ cwd: '/w' }, git(''))).toBeNull()
    expect(
      changedFiles({ base: 'origin/main' }, () => {
        throw new Error('fatal: bad revision')
      }),
    ).toBeNull()
  })

  it('is an empty list for a diff that lists nothing', () => {
    expect(changedFiles({ base: 'origin/main' }, git(''))).toEqual([])
  })
})
