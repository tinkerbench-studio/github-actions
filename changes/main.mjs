#!/usr/bin/env node
/** The changes action's entry: lists the change, answers the config's questions and sets them as outputs. A config that cannot be read fails the step. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { flag, input, setOutputs } from '../lib/actions.mjs'
import { answers, changedFiles, parseConfig } from './changes.mjs'

try {
  const config = input('config')
  const questions = config ? parseConfig(readFileSync(config, 'utf8')) : []
  const files = changedFiles({ base: input('base'), firstParent: flag('first-parent') })
  const result = answers(questions, files)

  console.log(files === null ? 'The change could not be listed, so nothing is skipped.' : `${files.length} changed file(s):`)
  for (const file of files ?? []) console.log(`  ${file}`)
  for (const [name, value] of Object.entries(result)) console.log(`${name}=${value}`)

  // The list as a file, for a later step with questions of its own: an output would be cut off at the runner's limit on a large change.
  const path = join(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'changes-')), 'files.txt')
  writeFileSync(path, (files ?? []).map(file => `${file}\n`).join(''))
  setOutputs({ ...Object.fromEntries(Object.entries(result).map(([name, value]) => [name, String(value)])), listed: String(files !== null), count: String(files?.length ?? 0), 'files-path': path })
} catch (error) {
  console.error(`::error title=changes::${error.message}`)
  process.exit(1)
}
