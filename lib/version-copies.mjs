/**
 * The copies of a version a repository keeps, as plain functions that import nothing: version-check and version-raise read files and git, and these decide.
 *
 * A repository names its copies one a line. A line that is a path alone is a JSON manifest's top-level `version` (package.json, plugin.json). A path, then
 * whitespace, then a regular expression is any other file: the expression must match the file exactly once and have one capture group, the version
 * (`hooks/state.ts MOD_VERSION = '([^']+)'`). Every copy must hold the same version.
 */

/** Each copy a `copies` input names, as `{ file, pattern }`, pattern null for a JSON manifest. Throws, naming the line, for one that cannot be read. */
export const parseCopies = text => {
  const copies = []
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const space = line.search(/\s/)
    if (space === -1) {
      copies.push({ file: line, pattern: null })
      continue
    }
    const file = line.slice(0, space)
    const source = line.slice(space).trim()
    let pattern
    try {
      pattern = new RegExp(source)
    } catch (error) {
      throw new Error(`The copy "${line}" has a pattern that is not a regular expression: ${error.message}`)
    }
    if (new RegExp(`${source}|`).exec('').length !== 2) throw new Error(`The copy "${line}" needs a pattern with exactly one capture group, the version.`)
    copies.push({ file, pattern })
  }
  if (copies.length === 0) throw new Error('No copies of the version are named: give at least one file.')
  return copies
}

/** Where the version stands in a copy's text: `{ version, start, end }`, the offsets of the version itself. Throws, naming the file, when it cannot be found once. */
export const locate = ({ file, pattern }, text) => {
  if (pattern === null) {
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch {
      throw new Error(`${file} is not JSON.`)
    }
    const version = manifest?.version
    if (typeof version !== 'string' || version.trim() === '') throw new Error(`${file} has no version.`)
    // The top-level version, found in the text so the file keeps its own layout: a key "version" with that value, and only one.
    const found = [...text.matchAll(/"version"\s*:\s*"((?:[^"\\]|\\.)*)"/dg)].filter(m => m[1] === version)
    if (found.length !== 1) throw new Error(`${file} has "version": "${version}" ${found.length === 0 ? 'in a form this cannot rewrite' : 'more than once'}.`)
    return { version, start: found[0].indices[1][0], end: found[0].indices[1][1] }
  }
  const found = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace(/[gd]/g, '')}gd`))]
  if (found.length !== 1) throw new Error(`${file} matches ${pattern} ${found.length} times; it must match once.`)
  const [start, end] = found[0].indices[1]
  return { version: found[0][1], start, end }
}

/** The version every copy holds. `versions` maps a file to its version. Throws, naming each, when they differ. */
export const agreed = versions => {
  const entries = Object.entries(versions)
  if (new Set(entries.map(([, version]) => version)).size > 1) throw new Error(`${entries.map(([file, version]) => `${file} says ${version}`).join(' but ')}: they must agree.`)
  return entries[0]?.[1]
}

export const PARTS = ['patch', 'minor', 'major']

/** The version after `version` with `part` raised: 1.4.2 is 1.4.3, 1.5.0 or 2.0.0. Throws for a version that is not major.minor.patch, or an unknown part. */
export const nextVersion = (version, part = 'patch') => {
  if (!PARTS.includes(part)) throw new Error(`"${part}" is not a part of a version: give ${PARTS.join(', ')}.`)
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`${version} is not a version of the form major.minor.patch, so it cannot be raised.`)
  const [major, minor, patch] = m.slice(1).map(Number)
  if (part === 'major') return `${major + 1}.0.0`
  if (part === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** A copy's text with its version replaced by `next`, the rest of the file as it was. */
export const rewrite = (copy, text, next) => {
  const { start, end } = locate(copy, text)
  return `${text.slice(0, start)}${next}${text.slice(end)}`
}
