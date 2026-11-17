/**
 * The few Vitest matchers the tests here use, over node:assert, so a test moved from a repository that runs Vitest needs its imports changed and nothing else,
 * and this repository installs no package to test itself.
 */
import assert from 'node:assert/strict'

const subset = (actual, expected) => {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected)
  if (actual === null || typeof actual !== 'object') return false
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => subset(actual[i], item))
  return Object.keys(expected).every(key => subset(actual[key], expected[key]))
}

const same = (a, b) => {
  try {
    assert.deepStrictEqual(a, b)
    return true
  } catch {
    return false
  }
}

const matchers = (actual, negate) => {
  const check = (pass, message) => assert.ok(negate ? !pass : pass, `expected ${JSON.stringify(actual)} ${negate ? 'not ' : ''}${message}`)
  return {
    toBe: expected => check(Object.is(actual, expected), `to be ${JSON.stringify(expected)}`),
    toEqual: expected => check(same(actual, expected), `to equal ${JSON.stringify(expected)}`),
    toBeNull: () => check(actual === null, 'to be null'),
    toContain: expected => check(actual.includes(expected), `to contain ${JSON.stringify(expected)}`),
    toHaveLength: expected => check(actual.length === expected, `to have length ${expected}`),
    toMatch: expected => check(expected instanceof RegExp ? expected.test(actual) : actual.includes(expected), `to match ${expected}`),
    toMatchObject: expected => check(subset(actual, expected), `to match object ${JSON.stringify(expected)}`),
    toThrow: expected => {
      let thrown
      try {
        actual()
      } catch (error) {
        thrown = error
      }
      const matches = thrown !== undefined && (expected === undefined || (expected instanceof RegExp ? expected.test(thrown.message) : thrown.message.includes(expected)))
      assert.ok(negate ? !matches : matches, `expected the function ${negate ? 'not ' : ''}to throw${expected === undefined ? '' : ` ${expected}`}${thrown ? `, and it threw ${thrown.message}` : ''}`)
    },
  }
}

export const expect = actual => ({ ...matchers(actual, false), not: matchers(actual, true) })
