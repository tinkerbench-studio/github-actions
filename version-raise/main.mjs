#!/usr/bin/env node
/**
 * The version-raise action's entry. Lists the files changed between `before` and `after`, and when one matches `paths` raises the version in every copy named in
 * `copies`, writing the files and nothing else: the workflow commits, tags and releases. Sets `raised`, `version`, `previous` and `reason`. Fails the step when a
 * copy cannot be read, the copies disagree or an input is wrong; when the changed files cannot be listed it raises nothing and says why.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import { input, oneLine, setOutputs, summarise } from '../lib/actions.mjs'
import { parseCopies } from '../lib/version-copies.mjs'
import { plan } from './raise.mjs'

const git = args => spawnSync('git', args, { encoding: 'utf8' })

/** The files changed between two commits, or null when either is not a commit this checkout holds (a new branch's all-zero before, a forced push). */
const changedBetween = (before, after) => {
  if (!before || /^0+$/.test(before)) return null
  for (const ref of [before, after]) if (git(['cat-file', '-e', `${ref}^{commit}`]).status !== 0) return null
  const listed = git(['diff', '--name-only', '-z', before, after, '--'])
  return listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : null
}

try {
  const copies = parseCopies(input('copies') || 'package.json').map(copy => ({ ...copy, text: readFileSync(copy.file, 'utf8') }))
  const paths = (input('paths') || '**').split(/[\n,]+/).map(path => path.trim()).filter(Boolean)
  const changed = changedBetween(input('before'), input('after') || 'HEAD')
  const result = plan({ changed, paths, part: input('part') || 'patch', copies })
  for (const { file, text } of result.edits ?? []) writeFileSync(file, text)
  console.log(result.reason)
  summarise(`${result.raised ? 'Raised' : 'Not raised'}: ${result.reason}`)
  setOutputs({ raised: String(result.raised), version: result.version ?? '', previous: result.previous ?? '', reason: result.reason })
} catch (error) {
  console.error(`::error title=Version raise::${oneLine(error.message)}`)
  process.exit(1)
}
