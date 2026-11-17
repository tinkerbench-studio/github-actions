/**
 * Whether a commit pushed to a branch holds exactly the files a pull request's CI already passed for, so the push's run need not test them again.
 *
 * A merge queue that brings a pull request up to date before it merges tests the tree that lands: a squash gives the branch a new commit, and so a commit GitHub holds
 * no pass for, but its tree is the pull request head's, byte for byte. This asks GitHub for that evidence and nothing else. It never asks whether a queue did the
 * merge: a merge that went round the queue has no such evidence (a branch behind its base gives another tree, a red or unfinished run is no pass, a push with no pull
 * request has none), so it is tested in full, and one that happens to have the evidence is as safe as a queued one.
 *
 * A commit is verified when all of these hold:
 *
 * 1. It is the merge commit of exactly one merged pull request into this branch, from a branch of this repository (never a fork).
 * 2. Its tree is the pull request head's tree.
 * 3. The pull request's head held every commit of the branch as it stood before the merge, so the merge the pull request's run tested was the head's own tree.
 * 4. The newest run of the workflow for that head, for a pull request, is complete and succeeded, and in it the gate job succeeded (skipped is not a pass).
 * 5. The commit before it on the branch is verified too: its own push run succeeded, or, while that run has not finished, the same evidence holds for it.
 *
 * The fifth is what makes path-filtered pull request runs sound. A job the pull request's diff could not affect did not run for it; it is known good only if the
 * branch was good underneath.
 *
 * Whatever cannot be read is an answer of no, with the reason: the run then tests everything, which is what happened before this existed.
 */

const no = reason => ({ verified: false, reason })

const sameRun = (a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1)

/** The newest run of `workflow` for `sha` and `event` from this repository, or null when there is none. */
export const latestRun = async (get, { repository, workflow, sha, event }) => {
  const query = new URLSearchParams({ head_sha: sha, event, per_page: '100' })
  const answer = await get(`/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`)
  const runs = (answer?.workflow_runs ?? []).filter(run => run.head_sha === sha && run.event === event && run.head_repository?.full_name === repository)
  return runs.sort(sameRun)[0] ?? null
}

/** Whether the job named `gate` succeeded in the newest attempt of `run`, with the reason when it did not. */
export const gatePassed = async (get, { repository, run, gate }) => {
  const answer = await get(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
  const job = (answer?.jobs ?? []).find(job => job.name === gate)
  if (!job) return no(`run ${run.id} has no job named ${gate}`)
  if (job.status !== 'completed' || job.conclusion !== 'success') return no(`the ${gate} job of run ${run.id} ended as ${job.conclusion ?? job.status}, not success`)
  return { verified: true }
}

/**
 * The evidence for one commit (points 1 to 4 above), then its parent's (point 5). `depth` is how many commits further back the same evidence may stand in for a
 * push run that has not finished.
 */
const evidence = async (get, context, sha, depth) => {
  const { repository, branch, workflow, gate } = context
  const commit = await get(`/repos/${repository}/git/commits/${sha}`)
  const parents = commit?.parents ?? []
  if (parents.length < 1 || parents.length > 2) return no(`${sha} has ${parents.length} parents, so it is not one pull request's merge`)
  const before = parents[0].sha

  const pulls = await get(`/repos/${repository}/commits/${sha}/pulls?per_page=100`)
  const merged = (pulls ?? []).filter(pull => pull.merged_at && pull.merge_commit_sha === sha && pull.base?.ref === branch)
  if (merged.length !== 1) return no(merged.length === 0 ? `${sha} is not the merge commit of a pull request into ${branch}` : `${sha} is the merge commit of ${merged.length} pull requests`)
  const [pull] = merged
  const head = pull.head?.sha
  if (pull.head?.repo?.full_name !== repository || !head) return no(`#${pull.number} comes from another repository`)

  const headCommit = await get(`/repos/${repository}/git/commits/${head}`)
  if (!commit.tree?.sha || commit.tree.sha !== headCommit?.tree?.sha) return no(`#${pull.number} merged as a tree its head ${head} did not have: it was behind ${branch}, or changed in the merge`)

  const compared = await get(`/repos/${repository}/compare/${before}...${head}`)
  if (compared?.behind_by !== 0) return no(`#${pull.number}'s head ${head} did not hold every commit of ${branch} at ${before}`)

  const run = await latestRun(get, { repository, workflow, sha: head, event: 'pull_request' })
  if (!run) return no(`${workflow} has no pull request run for #${pull.number}'s head ${head}`)
  if (run.status !== 'completed' || run.conclusion !== 'success') return no(`the newest ${workflow} run for #${pull.number}'s head (${run.id}) is ${run.conclusion ?? run.status}, not success`)
  const gateResult = await gatePassed(get, { repository, run, gate })
  if (!gateResult.verified) return gateResult

  const parent = await parentVerified(get, context, before, depth)
  if (!parent.verified) return no(`the commit before it is not verified: ${parent.reason}`)
  return { verified: true, reason: `#${pull.number}'s head ${head} has this tree and passed ${gate} in run ${run.id}`, pull: pull.number, head, run: run.id }
}

/** Point 5: the push run of the commit before succeeded, or it has not finished and that commit has the evidence itself. */
const parentVerified = async (get, context, sha, depth) => {
  const { repository, workflow } = context
  const run = await latestRun(get, { repository, workflow, sha, event: 'push' })
  if (run?.status === 'completed') return run.conclusion === 'success' ? { verified: true } : no(`the ${workflow} run for ${sha} (${run.id}) ended as ${run.conclusion}`)
  if (depth <= 0) return no(`the ${workflow} run for ${sha} has not finished, and that is as far back as this looks`)
  return evidence(get, context, sha, depth - 1)
}

/**
 * The answer for a run: `{ verified, reason }`, with `pull`, `head` and `run` (the pull request, the head that was tested and the run that passed) when it is yes.
 * Only a push to a branch can be verified. `get` reads a path of GitHub's API (lib/github.mjs).
 */
export const verify = async ({ event, ref, sha, repository, workflow, gate, depth = 5 }, get) => {
  if (event !== 'push') return no(`only a push can be verified, not a ${event || 'run with no event'}`)
  if (!ref?.startsWith('refs/heads/')) return no(`${ref || 'no ref'} is not a branch`)
  if (!sha || !repository || !workflow || !gate) return no('the commit, repository, workflow and gate are all needed')
  try {
    return await evidence(get, { repository, branch: ref.slice('refs/heads/'.length), workflow, gate }, sha, depth)
  } catch (error) {
    return no(`GitHub could not be read (${error.message})`)
  }
}
