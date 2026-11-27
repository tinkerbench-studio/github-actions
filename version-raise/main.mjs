#!/usr/bin/env node
/**
 * The version-raise action's entry. Lists the files changed between `before` and `after`, and when one matches `paths` raises the version in every copy named in
 * `copies`, writing the files and nothing else: the workflow commits, tags and releases. Sets `raised`, `version`, `previous` and `reason`. The part raised is
 * `part`, or more when the merged pull request has a release:minor or release:major label (`labels`, or read with `token`). Fails the step when a copy cannot
 * be read, the copies disagree, an input is wrong, a release: label is unknown or the labels cannot be read; when the changed files cannot be listed it raises nothing and says why.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import { input, oneLine, setOutputs, summarise } from '../lib/actions.mjs'
import { reader } from '../lib/github.mjs'
import { parseCopies } from '../lib/version-copies.mjs'
import { mergedLabels, plan } from './raise.mjs'

const git = args => spawnSync('git', args, { encoding: 'utf8' })

/** The files changed between two commits, or null when either is not a commit this checkout holds (a new branch's all-zero before, a forced push). */
const changedBetween = (before, after) => {
  if (!before || /^0+$/.test(before)) return null
  for (const ref of [before, after]) if (git(['cat-file', '-e', `${ref}^{commit}`]).status !== 0) return null
  const listed = git(['diff', '--name-only', '-z', before, after, '--'])
  return listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : null
}

/** The merged pull request's labels: the `labels` input when given, else read from GitHub with `token` when given, else none. */
const labelsOf = async after => {
  const given = input('labels')
  if (given) return given.split(/[\n,]+/).map(label => label.trim()).filter(Boolean)
  const token = input('token')
  if (!token) return []
  const sha = git(['rev-parse', '--verify', `${after}^{commit}`])
  if (sha.status !== 0) throw new Error(`Could not find the commit ${after}, so the merged pull request's labels cannot be read.`)
  const branch = (process.env.GITHUB_REF ?? '').replace(/^refs\/heads\//, '')
  try {
    return await mergedLabels({ repository: process.env.GITHUB_REPOSITORY, sha: sha.stdout.trim(), branch }, reader({ api: process.env.GITHUB_API_URL, token }))
  } catch (error) {
    throw new Error(`Could not read the merged pull request's labels (${error.message}), so which part to raise cannot be told.`)
  }
}

try {
  const after = input('after') || 'HEAD'
  const labels = await labelsOf(after)
  const copies = parseCopies(input('copies') || 'package.json').map(copy => ({ ...copy, text: readFileSync(copy.file, 'utf8') }))
  const paths = (input('paths') || '**').split(/[\n,]+/).map(path => path.trim()).filter(Boolean)
  const changed = changedBetween(input('before'), after)
  const result = plan({ changed, paths, part: input('part') || 'patch', labels, copies })
  for (const { file, text } of result.edits ?? []) writeFileSync(file, text)
  console.log(result.reason)
  summarise(`${result.raised ? 'Raised' : 'Not raised'}: ${result.reason}`)
  setOutputs({ raised: String(result.raised), version: result.version ?? '', previous: result.previous ?? '', reason: result.reason })
} catch (error) {
  console.error(`::error title=Version raise::${oneLine(error.message)}`)
  process.exit(1)
}
