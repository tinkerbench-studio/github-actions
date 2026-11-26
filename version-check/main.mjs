#!/usr/bin/env node
/**
 * The version-check action's entry. Reads each copy named in `copies` at the merge base of `base` and HEAD and in the checkout, and fails the step when the
 * pull request changed the version. Sets `ok` and `reason`. Fails too when a copy cannot be read, the copies disagree, or the merge base cannot be found:
 * a check that cannot tell does not pass.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { input, oneLine, setOutputs, summarise } from '../lib/actions.mjs'
import { parseCopies } from '../lib/version-copies.mjs'
import { check } from './check.mjs'

const git = args => spawnSync('git', args, { encoding: 'utf8' })

try {
  const copies = parseCopies(input('copies') || 'package.json')
  const base = input('base') || `origin/${process.env.GITHUB_BASE_REF || 'main'}`
  const found = git(['merge-base', base, 'HEAD'])
  if (found.status !== 0) throw new Error(`Could not find the merge base of ${base} and HEAD (check out with fetch-depth: 0), so the version cannot be checked.`)
  const mergeBase = found.stdout.trim()
  const at = file => {
    const shown = git(['show', `${mergeBase}:${file}`])
    return shown.status === 0 ? shown.stdout : null
  }
  const result = check({ copies: copies.map(copy => ({ ...copy, base: at(copy.file), head: readFileSync(copy.file, 'utf8') })) })
  summarise(result.reason)
  setOutputs({ ok: String(result.ok), reason: result.reason })
  if (!result.ok) {
    console.error(`::error title=Version check::${oneLine(result.reason)}`)
    process.exit(1)
  }
  console.log(result.reason)
} catch (error) {
  console.error(`::error title=Version check::${oneLine(error.message)}`)
  process.exit(1)
}
