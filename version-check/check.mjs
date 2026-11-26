/**
 * Whether a pull request left the version as it was, as a plain function that imports nothing but the shared ones: main.mjs reads git and the files. A
 * repository whose version is raised after the merge (version-raise) fails a pull request that changes one of its copies, so two pull requests cannot take
 * the same next version.
 */
import { agreed, locate } from '../lib/version-copies.mjs'

/**
 * `copies` is each copy, `{ file, pattern, base, head }`: its text at the merge base (null when the file was not there) and now. Returns `{ ok, reason }`.
 * Throws when a copy cannot be read now, or the copies now disagree.
 */
export const check = ({ copies }) => {
  const now = agreed(Object.fromEntries(copies.map(copy => [copy.file, locate(copy, copy.head).version])))
  const moved = []
  for (const copy of copies) {
    if (copy.base === null) continue
    let then
    try {
      then = locate(copy, copy.base).version
    } catch {
      // A copy the base held in another form, or not at all, has no version there to compare: the pull request is adding it.
      continue
    }
    const head = locate(copy, copy.head).version
    if (then !== head) moved.push(`${copy.file} from ${then} to ${head}`)
  }
  if (moved.length > 0) return { ok: false, reason: `This pull request changes the version (${moved.join(', ')}). Leave it as it was: it is raised after the merge.` }
  return { ok: true, reason: `The version is ${now}, as on the base.` }
}
