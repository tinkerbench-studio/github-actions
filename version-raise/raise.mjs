/**
 * Whether a merge should raise the version, and the raised copies, as plain functions that import nothing but the shared ones: main.mjs reads git and the files,
 * and writes what this returns. A merge raises the version when it changed a file the repository names in `paths`. Anything that cannot be told is answered
 * no, with the reason.
 */
import { matchesAny } from '../lib/glob.mjs'
import { agreed, locate, nextVersion, rewrite } from '../lib/version-copies.mjs'

/**
 * What to raise. `changed` is the files the merge changed, or null when they could not be listed. `copies` is each copy with its text, `{ file, pattern, text }`.
 * Returns `{ raised, reason }`, and when raised also `previous`, `version` and `edits` (`[{ file, text }]`, one for each copy). Throws when a copy cannot be read,
 * the copies disagree, or the version cannot be raised: then nothing should be written.
 */
export const plan = ({ changed, paths, part = 'patch', copies }) => {
  // Every copy is read, and they must agree, before anything is decided: a repository whose copies have drifted learns it on every merge.
  const previous = agreed(Object.fromEntries(copies.map(copy => [copy.file, locate(copy, copy.text).version])))
  if (changed === null) return { raised: false, reason: 'Could not list the files the merge changed, so the version is not raised.' }
  const hits = changed.filter(path => matchesAny(path, paths))
  if (hits.length === 0) return { raised: false, reason: `The merge changed nothing under ${paths.join(', ')}: the version stays ${previous}.` }
  const version = nextVersion(previous, part)
  const edits = copies.map(copy => ({ file: copy.file, text: rewrite(copy, copy.text, version) }))
  const more = hits.length > 1 ? ` and ${hits.length - 1} more` : ''
  return { raised: true, previous, version, edits, reason: `The merge changed ${hits[0]}${more}: the ${part} version is raised from ${previous} to ${version}.` }
}
