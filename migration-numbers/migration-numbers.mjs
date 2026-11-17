/**
 * Whether a folder of D1 migrations is numbered once each.
 *
 * D1 applies a migrations folder in file-name order and records each file by name, so two files with one number apply in an order nobody chose, and a file renamed
 * after it ran is applied again. Two pull requests written against the same main each take the next free number, and each passes alone: that is how the clash
 * happens. Nookivia wrote this check (scripts/migration-numbers.ts there) and Tick-it copied it; this is the one copy.
 *
 * Imports nothing, so a repository's own test can run it too.
 */

const NAME = /^\d{4}_[a-z0-9_]+\.sql$/

/**
 * What is wrong with a set of migration file names; empty when nothing is.
 * `contiguous` also requires them to run from 0001 with no gaps. `shared` names the numbers two files are allowed to share, as `{ "0026": ["0026_a.sql", "0026_b.sql"] }`:
 * for a clash that already ran everywhere and so cannot be renamed. Exactly those files may hold that number.
 */
export const numberingProblems = (names, { contiguous = false, shared = {} } = {}) => {
  const files = [...new Set(names)].sort()
  const problems = files.filter(name => !NAME.test(name)).map(name => `${name} is not named NNNN_snake_case.sql.`)

  const byNumber = new Map()
  for (const name of files.filter(name => NAME.test(name))) {
    const number = name.slice(0, 4)
    byNumber.set(number, [...(byNumber.get(number) ?? []), name])
  }
  for (const [number, named] of byNumber) {
    const allowed = shared[number]
    if (named.length > 1 && named.join() !== [...(allowed ?? [])].sort().join()) problems.push(`${number} is taken by ${named.join(' and ')}. Renumber the one that has not merged to the next free number.`)
  }

  if (contiguous) {
    const gap = [...byNumber.keys()].map(Number).findIndex((number, i) => number !== i + 1)
    if (gap >= 0) problems.push(`${String(gap + 1).padStart(4, '0')} is missing: migrations run from 0001 with no gaps.`)
  }
  return problems
}

/**
 * The migrations `after` holds that `before` did not: what the base branch gained since a pull request's merge commit was made.
 * A file the base renamed or removed since is in `before` only, so it is not counted.
 */
export const gainedSince = (before, after) => {
  const held = new Set(before)
  return [...after].filter(name => !held.has(name))
}

/** The file name of a path directly inside `directory` that ends in .sql; undefined for any other path. */
export const migrationName = (file, directory = 'migrations') => {
  const prefix = `${directory.replace(/\/+$/, '')}/`
  if (!file.startsWith(prefix) || !file.endsWith('.sql')) return undefined
  const name = file.slice(prefix.length)
  return name.includes('/') ? undefined : name
}

/**
 * The migrations the base branch would hold with a pull request merged into it. `files` are the pull request's files as GitHub's API lists them
 * (`GET /repos/{owner}/{repo}/pulls/{n}/files`: filename, status, previous_filename).
 */
export const withPullRequest = (main, files, directory = 'migrations') => {
  const names = new Set(main)
  for (const file of files) {
    const previous = migrationName(file.previous_filename ?? '', directory)
    if (previous) names.delete(previous)
    const name = migrationName(file.filename, directory)
    if (!name) continue
    if (file.status === 'removed') names.delete(name)
    else names.add(name)
  }
  return [...names]
}
