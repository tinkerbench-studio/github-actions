#!/usr/bin/env node
/** The verified-tree action's entry: reads its inputs, asks (verified-tree.mjs) and sets the outputs. It never fails the job: an answer of no runs the tests. */
import { input, oneLine, setOutputs, summarise } from '../lib/actions.mjs'
import { reader } from '../lib/github.mjs'
import { verify } from './verified-tree.mjs'

const env = process.env
const depth = Number.parseInt(input('depth'), 10)
let result
try {
  const get = reader({ api: env.GITHUB_API_URL, token: input('token') })
  result = await verify(
    {
      event: env.GITHUB_EVENT_NAME,
      ref: env.GITHUB_REF,
      sha: input('sha') || env.GITHUB_SHA,
      repository: env.GITHUB_REPOSITORY,
      workflow: input('workflow'),
      gate: input('gate'),
      depth: Number.isInteger(depth) && depth >= 0 ? depth : 5,
    },
    get,
  )
} catch (error) {
  result = { verified: false, reason: error.message }
}

const line = result.verified ? `Verified, so nothing is tested again: ${result.reason}.` : `Not verified, so everything runs: ${result.reason}.`
console.log(`::notice title=verified-tree::${oneLine(line)}`)
summarise(line)
setOutputs({ verified: String(result.verified), reason: oneLine(result.reason), 'pull-request': result.pull ?? '', 'tested-sha': result.head ?? '', 'run-id': result.run ?? '' })
