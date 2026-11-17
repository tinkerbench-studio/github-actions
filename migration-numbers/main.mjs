#!/usr/bin/env node
/**
 * The migration-numbers action's entry. With no options it checks the checkout's folder. `against` and `base` add the migrations `against` gained since `base`, so a
 * pull request's run sees what merged after its merge commit was made. `pull-request-files` applies a pull request's files, as GitHub's API lists them, to the
 * checkout (the latest base branch). Fails the step, with each problem as an error, when a number is used twice.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

import { flag, input, oneLine } from '../lib/actions.mjs'
import { gainedSince, migrationName, numberingProblems, withPullRequest } from './migration-numbers.mjs'

const directory = (input('directory') || 'migrations').replace(/\/+$/, '')

const atRef = ref =>
  execFileSync('git', ['ls-tree', '--name-only', ref, `${directory}/`], { encoding: 'utf8' })
    .split('\n')
    .map(file => migrationName(file, directory))
    .filter(name => name !== undefined)

try {
  const against = input('against')
  const base = input('base')
  if (Boolean(against) !== Boolean(base)) throw new Error('against and base are given together or not at all')
  const shared = input('shared') ? JSON.parse(input('shared')) : {}

  let names = readdirSync(directory).filter(name => name.endsWith('.sql'))
  if (against) {
    const since = gainedSince(atRef(base), atRef(against))
    console.log(`${against} gained since ${base}: ${since.join(', ') || '(no migrations)'}`)
    names = [...names, ...since]
  }
  const files = input('pull-request-files')
  if (files) names = withPullRequest(names, JSON.parse(readFileSync(files, 'utf8')), directory)

  const problems = numberingProblems(names, { contiguous: flag('contiguous'), shared })
  for (const problem of problems) console.error(`::error title=Migration numbers::${oneLine(problem)}`)
  if (problems.length > 0) process.exit(1)
  console.log(`${new Set(names).size} migrations in ${directory}, numbered once each.`)
} catch (error) {
  console.error(`::error title=Migration numbers::${oneLine(error.message)}`)
  process.exit(1)
}
