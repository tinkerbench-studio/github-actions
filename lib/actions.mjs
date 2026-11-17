/**
 * What every action here needs from the runner: its inputs, its outputs and a line on the run's page.
 * No package is installed for any of this, so an action runs from a bare checkout of this repository.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

/** An input as the runner hands it to a JavaScript action (INPUT_<NAME>, spaces as underscores), trimmed; '' when it was not given. */
export const input = (name, env = process.env) => (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim()

/** An input that is `true` or `false`; anything else, and nothing, is `fallback`. */
export const flag = (name, fallback = false, env = process.env) => {
  const value = input(name, env).toLowerCase()
  return value === 'true' ? true : value === 'false' ? false : fallback
}

/** The lines that set `values` as outputs. Each value is written between a delimiter of its own, so a value with a newline in it cannot set another output. */
export const outputLines = (values, delimiter = () => `ghadelimiter_${randomUUID()}`) =>
  Object.entries(values)
    .map(([name, value]) => {
      const mark = delimiter()
      return `${name}<<${mark}\n${value}\n${mark}\n`
    })
    .join('')

/** Sets the step's outputs. Outside a run (no GITHUB_OUTPUT) it prints them. */
export const setOutputs = (values, env = process.env) => {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, outputLines(values))
  else for (const [name, value] of Object.entries(values)) console.log(`${name}=${value}`)
}

/** One line in the job's summary, when there is one. */
export const summarise = (line, env = process.env) => {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`)
}

/** A workflow command's text on one line: the runner reads a command to the end of its line. */
export const oneLine = text => String(text).replace(/\r?\n/g, ' ')
