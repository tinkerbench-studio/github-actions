import { describe, it } from 'node:test'

import { expect } from '../lib/expect.mjs'
import { DEFAULT_WAITS, isD1Overloaded, parseWaits, retryWhenOverloaded, wranglerArgs } from './apply.mjs'

const CPU = 'D1 DB exceeded its CPU time limit and was reset. [code: 7429]'
const WINDOW = 'D1 DB is overloaded. Too many resources consumed within a 10 second window. [code: 7429]'
const failed = text => new Error(`wrangler d1 migrations apply failed with status 1:\n${text}`)

describe('isD1Overloaded', () => {
  it('reads code 7429 in both of Cloudflare messages', () => {
    expect(isD1Overloaded(CPU)).toBe(true)
    expect(isD1Overloaded(WINDOW)).toBe(true)
  })

  it('is false for another code, another failure and no text', () => {
    expect(isD1Overloaded('D1 DB is overloaded [code: 7500]')).toBe(false)
    expect(isD1Overloaded('near "FROM": syntax error [code: 7500]')).toBe(false)
    expect(isD1Overloaded('')).toBe(false)
    expect(isD1Overloaded(undefined)).toBe(false)
  })
})

describe('parseWaits', () => {
  it('is 15, 30, 60 and 120 seconds when nothing is given', () => {
    expect(parseWaits(undefined)).toEqual([15, 30, 60, 120])
    expect(DEFAULT_WAITS).toEqual([15, 30, 60, 120])
  })

  it('takes whole seconds, none for an empty value, and refuses anything else', () => {
    expect(parseWaits('0, 0,5')).toEqual([0, 0, 5])
    expect(parseWaits('')).toEqual([])
    expect(() => parseWaits('15,soon')).toThrow(/whole seconds/)
    expect(() => parseWaits('-1')).toThrow(/whole seconds/)
    expect(() => parseWaits('1.5')).toThrow(/whole seconds/)
  })
})

describe('wranglerArgs', () => {
  it('names the database, remote by default, and the config when there is one', () => {
    expect(wranglerArgs({ database: 'tickit' })).toEqual(['wrangler', 'd1', 'migrations', 'apply', 'tickit', '--remote'])
    expect(wranglerArgs({ database: 'DB', config: 'wrangler.generated.toml', remote: true })).toEqual(['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.generated.toml'])
    expect(wranglerArgs({ database: 'TRAINING_DB', remote: false })).toEqual(['wrangler', 'd1', 'migrations', 'apply', 'TRAINING_DB', '--local'])
  })

  it('refuses a database that is not a plain name, so nothing is read as an option or reaches a shell', () => {
    for (const database of ['', undefined, '--remote', '-x', 'a b', 'a;b', 'a$(b)', 'a\nb', 'x'.repeat(101)]) expect(() => wranglerArgs({ database })).toThrow(/database must be/)
  })

  it('refuses a config that is an option or has a line break', () => {
    expect(() => wranglerArgs({ database: 'DB', config: '--config' })).toThrow(/config must be/)
    expect(() => wranglerArgs({ database: 'DB', config: 'a.toml\nb.toml' })).toThrow(/config must be/)
  })
})

describe('retryWhenOverloaded', () => {
  const run = async (failures, waits = [15, 30, 60]) => {
    const slept = []
    const logged = []
    let calls = 0
    const attempt = async () => {
      const next = failures[calls++]
      if (next) throw next
      return 'applied'
    }
    const result = await retryWhenOverloaded(attempt, { waits, sleep: async seconds => void slept.push(seconds), log: line => void logged.push(line) }).then(
      done => ({ ...done }),
      error => ({ error }),
    )
    return { ...result, calls, slept, logged }
  }

  it('answers at once, without waiting, when the first attempt works', async () => {
    expect(await run([null])).toMatchObject({ value: 'applied', attempts: 1, calls: 1, slept: [], logged: [] })
  })

  it('waits as long as each wait in turn and tries again until it works', async () => {
    const r = await run([failed(WINDOW), failed(WINDOW), null])
    expect(r).toMatchObject({ value: 'applied', attempts: 3, calls: 3, slept: [15, 30] })
    expect(r.logged).toHaveLength(2)
    expect(r.logged[0]).toContain('waiting 15 s before attempt 2 of 4')
    expect(r.logged[1]).toContain('waiting 30 s before attempt 3 of 4')
  })

  it('retries the CPU-limit message too', async () => {
    expect(await run([failed(CPU), null])).toMatchObject({ attempts: 2, slept: [15] })
  })

  it('throws the last 7429 once the waits are used up, after one attempt more than there are waits', async () => {
    const last = failed(WINDOW)
    const r = await run([failed(WINDOW), failed(WINDOW), failed(WINDOW), last])
    expect(r.error === last).toBe(true)
    expect(r).toMatchObject({ calls: 4, slept: [15, 30, 60] })
  })

  it('does not retry any other failure, and waits for none', async () => {
    const syntax = failed('near "FROM": syntax error [code: 7500]')
    const r = await run([syntax])
    expect(r.error === syntax).toBe(true)
    expect(r).toMatchObject({ calls: 1, slept: [], logged: [] })
  })

  it('does not retry when there are no waits', async () => {
    const only = failed(WINDOW)
    const r = await run([only], [])
    expect(r.error === only).toBe(true)
    expect(r.calls).toBe(1)
  })
})
