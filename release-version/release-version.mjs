/**
 * Whether a push to a branch raised a package's version and so should be released, as plain functions that import nothing: main.mjs reads git and these decide.
 * A release is a version no tag names yet whose number changed in this push. Anything that cannot be told is answered no, with the reason.
 */

/** The `version` of a JSON manifest's text. Throws, naming `name`, when the text is not JSON or has no version. */
export const versionOf = (text, name) => {
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error(`${name} is not JSON.`)
  }
  const version = manifest?.version
  if (typeof version !== 'string' || version.trim() === '') throw new Error(`${name} has no version.`)
  return version.trim()
}

/** A sentence naming the files whose versions differ, or null when they all agree (or there are none). `versions` maps a file to its version. */
export const disagreement = versions => {
  const entries = Object.entries(versions)
  if (new Set(entries.map(([, version]) => version)).size <= 1) return null
  return `${entries.map(([file, version]) => `${file} says ${version}`).join(' but ')}: they must agree.`
}

/**
 * Whether to release `version`, and why in one line.
 * `before` is the version at the commit before the push, or undefined when there is none to compare with (a new branch, a forced push, a file that was not there).
 * Then only the tag decides. `tagExists` is undefined when GitHub could not be asked, and then nothing is released.
 */
export const decide = ({ version, before, tagExists, tag }) => {
  if (tagExists === undefined) return { release: false, reason: `Could not tell whether ${tag} exists, so nothing is released.` }
  if (tagExists) return { release: false, reason: `${tag} already exists: nothing to release.` }
  if (before === version) return { release: false, reason: `The version is still ${version}: nothing to release.` }
  if (before === undefined) return { release: true, reason: `There is no earlier version to compare with and ${tag} has no tag, so ${version} is released.` }
  return { release: true, reason: `The version went from ${before} to ${version} and ${tag} has no tag.` }
}
