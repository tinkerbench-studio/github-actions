#!/usr/bin/env node
/**
 * The d1-migrations-apply action's entry. Runs `npx wrangler d1 migrations apply` in the working directory, with the arguments as an array so no input reaches a shell,
 * and again after each wait when D1 answers code 7429. wrangler's own output is passed on as it comes; the step fails with its text when anything else goes wrong
 * or the waits are used up.
 */
import { spawnSync } from 'node:child_process'

import { flag, input, oneLine, setOutputs } from '../lib/actions.mjs'
import { parseWaits, retryWhenOverloaded, wranglerArgs } from './apply.mjs'

try {
  const args = wranglerArgs({ database: input('database'), config: input('config'), remote: flag('remote', true) })
  const waits = parseWaits(process.env.INPUT_WAITS)
  const cwd = input('working-directory') || '.'

  const { attempts } = await retryWhenOverloaded(
    () => {
      const ran = spawnSync('npx', args, { cwd, encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      if (ran.stdout) process.stdout.write(ran.stdout)
      if (ran.stderr) process.stderr.write(ran.stderr)
      if (ran.error) throw new Error(`could not run npx: ${ran.error.message}`)
      if (ran.status !== 0) throw new Error(`wrangler d1 migrations apply failed with status ${ran.status}:\n${ran.stdout}\n${ran.stderr}`.trim())
    },
    { waits },
  )
  setOutputs({ attempts })
  console.log(`Migrations applied in ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}.`)
} catch (error) {
  console.error(`::error title=D1 migrations apply::${oneLine(error.message).slice(0, 600)}`)
  process.exit(1)
}
