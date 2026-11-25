/**
 * Applying D1 migrations when D1 may refuse them for load.
 *
 * Cloudflare answers code 7429 in two messages: "D1 DB exceeded its CPU time limit and was reset" (one statement was too much) and "D1 DB is overloaded. Too many
 * resources consumed within a 10 second window" (a run of small statements was). `wrangler d1 migrations apply` records each migration it finishes, so an attempt
 * after a failure starts at the first one not yet applied: the second message clears with time, and the first fails the same way again and is given up on after
 * the last wait. This module imports nothing, so a repository's own test can run the same logic.
 */

/** Seconds to wait before each further attempt: four more attempts after the first, about four minutes in all. */
export const DEFAULT_WAITS = [15, 30, 60, 120]

/** True when wrangler's failure text carries Cloudflare's code 7429, in either of its messages. */
export const isD1Overloaded = text => /\[code:\s*7429\]/.test(String(text))

/**
 * The waits an input names: whole seconds separated by commas, `0` for none, empty for no retry. `undefined` is the default. Anything else is refused,
 * so a typo does not quietly turn the wait off.
 */
export const parseWaits = value => {
  if (value === undefined) return DEFAULT_WAITS
  if (value.trim() === '') return []
  const waits = value.split(',').map(part => part.trim())
  if (!waits.every(part => /^\d+$/.test(part))) throw new Error(`waits must be whole seconds separated by commas, such as "15,30,60": got "${value}"`)
  return waits.map(Number)
}

/** A D1 database's name or binding: what wrangler takes, and never something it would read as an option. */
const DATABASE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/

/**
 * The arguments for `npx`, as an array and never a shell line. The database and the config come from a workflow's inputs, so each is checked: a name that starts
 * with a dash would be read as an option, and a config path may not carry a line break.
 */
export const wranglerArgs = ({ database, config = '', remote = true }) => {
  if (!DATABASE.test(database ?? '')) throw new Error(`database must be a D1 database name or binding of letters, digits, "_", "." and "-": got "${database ?? ''}"`)
  if (config.startsWith('-') || /[\r\n]/.test(config)) throw new Error('config must be a file path, not an option and not several lines')
  return ['wrangler', 'd1', 'migrations', 'apply', database, remote ? '--remote' : '--local', ...(config === '' ? [] : ['--config', config])]
}

const sleepFor = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000))

/**
 * Runs `attempt`, which throws when it fails, again after each wait in `waits` for as long as it fails with code 7429; any other failure is thrown at once,
 * and so is the last 7429 once the waits are used up. Answers what `attempt` answered and how many times it ran.
 */
export async function retryWhenOverloaded(attempt, { waits = DEFAULT_WAITS, sleep = sleepFor, log = console.error } = {}) {
  for (let tried = 0; ; tried++) {
    try {
      return { value: await attempt(), attempts: tried + 1 }
    } catch (error) {
      if (!isD1Overloaded(error?.message) || tried >= waits.length) throw error
      const seconds = waits[tried]
      log(`D1 refused the migrations for load (code 7429); waiting ${seconds} s before attempt ${tried + 2} of ${waits.length + 1}. Migrations already applied are kept.`)
      await sleep(seconds)
    }
  }
}
