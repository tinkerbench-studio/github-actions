/**
 * Lists the files a change touches and answers a repository's own yes-or-no questions about them, so a workflow starts only the jobs the change needs.
 *
 * The mechanism is shared; the definitions are not. Each repository keeps its questions in one JSON file (the `config` input), so "documentation" is written once
 * there instead of in a script, a workflow's step and a paths filter that must be kept in step by hand:
 *
 *   { "outputs": {
 *       "docs_only": { "every": ["/docs/**", "*.md", "/.claude/**"], "except": ["/docs/**\/*.test.ts"] },
 *       "storybook": { "any": ["/stories/**", "/components/**"] } } }
 *
 * - `every`: true when the change lists at least one file and every file matches one of the globs. A file that matches an `except` glob does not count as matching.
 * - `any`: true when some file matches one of the globs and no `except` glob.
 *
 * A change that could not be listed (a push with no base, a diff git cannot read) or that lists nothing is never guessed at: `every` answers false and `any` answers
 * true, which is the answer that runs the work. `unlisted` on a question sets another answer for that case.
 * The globs are Tick-it's (lib/glob.mjs): they match at any depth unless they start with `/`.
 */
import { execFileSync } from 'node:child_process'

import { matchesAny } from '../lib/glob.mjs'

/** The outputs the action sets itself, which a question cannot be named after. */
export const RESERVED = ['listed', 'count', 'files-path']

const globs = (value, where) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(glob => typeof glob !== 'string' || glob === '')) throw new Error(`${where} must be a list of globs`)
  return value
}

/** The questions of a config file's text, checked: `[{ name, kind, globs, except, unlisted }]`. Throws, naming what is wrong, on anything else. */
export const parseConfig = text => {
  let outputs
  try {
    outputs = JSON.parse(text).outputs
  } catch (error) {
    throw new Error(`the config is not JSON (${error.message})`)
  }
  if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) throw new Error('the config needs an "outputs" object')
  return Object.entries(outputs).map(([name, question]) => {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || RESERVED.includes(name)) throw new Error(`${name} cannot be an output's name`)
    const kinds = ['every', 'any'].filter(kind => question?.[kind] !== undefined)
    if (kinds.length !== 1) throw new Error(`${name} needs exactly one of "every" and "any"`)
    const [kind] = kinds
    const list = globs(question[kind], `${name}.${kind}`)
    if (list.length === 0) throw new Error(`${name}.${kind} must name at least one glob`)
    if (question.unlisted !== undefined && typeof question.unlisted !== 'boolean') throw new Error(`${name}.unlisted must be true or false`)
    return { name, kind, globs: list, except: globs(question.except, `${name}.except`), unlisted: question.unlisted ?? kind === 'any' }
  })
}

/** One question's answer for `files`: the list of changed files, or null when the change could not be listed. */
export const answer = (question, files) => {
  if (!files || files.length === 0) return question.unlisted
  const matches = file => matchesAny(file, question.globs) && !matchesAny(file, question.except)
  return question.kind === 'every' ? files.every(matches) : files.some(matches)
}

/** Every question's answer, by name. */
export const answers = (questions, files) => Object.fromEntries(questions.map(question => [question.name, answer(question, files)]))

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * The files the checkout changes, or null when git cannot say or nothing says what to compare with.
 * With `base`, the files changed since the merge base with it (a checkout with history). With `firstParent`, a pull request's merge commit against its first
 * parent, which needs a checkout two commits deep and no more. With neither, null.
 */
export const changedFiles = ({ base, firstParent = false, cwd = process.cwd() }, run = git) => {
  try {
    const args = base ? ['diff', '--name-only', '--no-renames', `${base}...HEAD`] : firstParent ? ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'] : null
    return args === null ? null : run(args, cwd).split('\n').filter(Boolean)
  } catch {
    return null
  }
}
