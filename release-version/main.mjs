#!/usr/bin/env node
/**
 * The release-version action's entry. Reads the version in each named file at this checkout and, from the commit before the push, in the first of them, then asks
 * the remote whether the version's tag exists, and sets `release`, `version` and `reason`. It tags and publishes nothing. Fails the step only when the files
 * disagree about the version; whatever else it cannot tell, it answers `release: false` and says why.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { input, oneLine, setOutputs, summarise } from '../lib/actions.mjs'
import { decide, disagreement, versionOf } from './release-version.mjs'

const git = args => spawnSync('git', args, { encoding: 'utf8' })

try {
  const files = (input('files') || 'package.json').split(/[\n,]+/).map(file => file.trim()).filter(Boolean)
  const versions = Object.fromEntries(files.map(file => [file, versionOf(readFileSync(file, 'utf8'), file)]))
  const problem = disagreement(versions)
  if (problem) throw new Error(problem)
  const version = versions[files[0]]
  const tag = `${input('tag-prefix')}${version}`

  // A new branch's "before" is all zeros and a forced push's is a commit the clone does not hold: neither can be compared with.
  const sha = input('before')
  let before
  if (sha && !/^0+$/.test(sha) && git(['cat-file', '-e', `${sha}^{commit}`]).status === 0) {
    const shown = git(['show', `${sha}:${files[0]}`])
    if (shown.status === 0) before = versionOf(shown.stdout, `${files[0]} at ${sha}`)
  }

  // Exit 2 is "no such ref"; any other failure means the remote was not asked.
  const listed = git(['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`])
  const tagExists = listed.status === 0 ? true : listed.status === 2 ? false : undefined

  const { release, reason } = decide({ version, before, tagExists, tag })
  console.log(reason)
  summarise(`${release ? 'Releasing' : 'Not releasing'} ${tag}: ${reason}`)
  setOutputs({ release: String(release), version, tag, reason })
} catch (error) {
  console.error(`::error title=Release version::${oneLine(error.message)}`)
  process.exit(1)
}
