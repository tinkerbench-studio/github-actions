/**
 * Whether a merge should raise the version, and the raised copies, as plain functions that import nothing but the shared ones: main.mjs reads git and the files,
 * and writes what this returns. A merge raises the version when it changed a file the repository names in `paths`. Anything that cannot be told is answered
 * no, with the reason.
 */
import { matchesAny } from '../lib/glob.mjs'
import { agreed, locate, nextVersion, PARTS, rewrite } from '../lib/version-copies.mjs'

/** The labels a merged pull request may carry to raise more than the patch, and the part each raises. */
export const RELEASE_LABELS = { 'release:minor': 'minor', 'release:major': 'major' }

/**
 * The part to raise: the larger of `part` and the part a `release:` label among `labels` asks for, so release:major beats release:minor and both beat patch.
 * Labels that do not start with `release:` are not read. Throws, naming it, for a `release:` label that is not one of RELEASE_LABELS: a misspelt label must
 * not quietly raise the patch.
 */
export const partFor = ({ part = 'patch', labels = [] }) => {
  if (!PARTS.includes(part)) throw new Error(`"${part}" is not a part of a version: give ${PARTS.join(', ')}.`)
  let chosen = part
  for (const label of labels) {
    if (!label.startsWith('release:')) continue
    const asked = RELEASE_LABELS[label]
    if (!asked) throw new Error(`The pull request has the label "${label}", which is not a release label: the known ones are ${Object.keys(RELEASE_LABELS).join(' and ')}.`)
    if (PARTS.indexOf(asked) > PARTS.indexOf(chosen)) chosen = asked
  }
  return chosen
}

/**
 * The labels of the pull requests merged as `sha` into `branch`, read with `get` (lib/github.mjs's reader). A push that came from no pull request has none.
 * Throws when GitHub cannot be asked: the caller cannot tell which part to raise, so it raises nothing.
 */
export const mergedLabels = async ({ repository, sha, branch }, get) => {
  const pulls = await get(`/repos/${repository}/commits/${sha}/pulls?per_page=100`)
  const merged = (pulls ?? []).filter(pull => pull.merged_at && pull.merge_commit_sha === sha && (!branch || pull.base?.ref === branch))
  return [...new Set(merged.flatMap(pull => (pull.labels ?? []).map(label => label.name)))]
}

/**
 * What to raise. `changed` is the files the merge changed, or null when they could not be listed. `copies` is each copy with its text, `{ file, pattern, text }`.
 * `labels` is the merged pull request's labels (partFor). Returns `{ raised, reason }`, and when raised also `previous`, `version` and `edits`
 * (`[{ file, text }]`, one for each copy). Throws when a copy cannot be read, the copies disagree, a release: label is unknown, or the version cannot be raised:
 * then nothing should be written.
 */
export const plan = ({ changed, paths, part: given = 'patch', labels = [], copies }) => {
  // The part is settled first, so an unknown release: label fails the merge whether or not this copy would be raised.
  const part = partFor({ part: given, labels })
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
