import { describe, it } from 'node:test'

import { expect } from '../lib/expect.mjs'
import { gatePassed, latestRun, verify } from './verified-tree.mjs'

const REPO = 'acme/app'
const RUN = { event: 'push', ref: 'refs/heads/main', sha: 'merge2', repository: REPO, workflow: 'ci.yml', gate: 'qa' }

/**
 * A repository as GitHub's API would describe it, for a main of base <- merge1 <- merge2. merge2 is #12 squashed (head `head2`, tree `tree2`), up to date with main
 * at merge1, with a pull request run that passed and a `qa` job that succeeded. merge1's own push run passed. Each test changes one thing.
 */
const world = () => ({
  commits: {
    merge2: { tree: { sha: 'tree2' }, parents: [{ sha: 'merge1' }] },
    head2: { tree: { sha: 'tree2' }, parents: [{ sha: 'merge1' }] },
    merge1: { tree: { sha: 'tree1' }, parents: [{ sha: 'base' }] },
    head1: { tree: { sha: 'tree1' }, parents: [{ sha: 'base' }] },
  },
  pulls: {
    merge2: [{ number: 12, merged_at: '2026-11-17T10:00:00Z', merge_commit_sha: 'merge2', base: { ref: 'main' }, head: { sha: 'head2', repo: { full_name: REPO } } }],
    merge1: [{ number: 11, merged_at: '2026-11-17T09:00:00Z', merge_commit_sha: 'merge1', base: { ref: 'main' }, head: { sha: 'head1', repo: { full_name: REPO } } }],
  },
  behind: { 'merge1...head2': 0, 'base...head1': 0 },
  runs: [
    { id: 200, head_sha: 'head2', event: 'pull_request', status: 'completed', conclusion: 'success', created_at: '2026-11-17T09:30:00Z', head_repository: { full_name: REPO } },
    { id: 100, head_sha: 'head1', event: 'pull_request', status: 'completed', conclusion: 'success', created_at: '2026-11-17T08:30:00Z', head_repository: { full_name: REPO } },
    { id: 150, head_sha: 'merge1', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-17T09:00:05Z', head_repository: { full_name: REPO } },
  ],
  jobs: { 200: [{ name: 'qa', status: 'completed', conclusion: 'success' }], 100: [{ name: 'qa', status: 'completed', conclusion: 'success' }] },
})

/** Reads a path from a world, as lib/github.mjs's reader would from GitHub; a path the world does not hold answers 404. `asked` collects the paths. */
const api = (w, asked = []) => async path => {
  asked.push(path)
  const url = new URL(path, 'https://api.github.test')
  const part = url.pathname.slice(`/repos/${REPO}`.length)
  let match
  if ((match = /^\/git\/commits\/(.+)$/.exec(part)) && w.commits[match[1]]) return w.commits[match[1]]
  if ((match = /^\/commits\/(.+)\/pulls$/.exec(part))) return w.pulls[match[1]] ?? []
  if ((match = /^\/compare\/(.+)$/.exec(part)) && match[1] in w.behind) return { behind_by: w.behind[match[1]] }
  if (/^\/actions\/workflows\/ci\.yml\/runs$/.test(part)) return { workflow_runs: w.runs.filter(run => run.head_sha === url.searchParams.get('head_sha') && run.event === url.searchParams.get('event')) }
  if ((match = /^\/actions\/runs\/(\d+)\/jobs$/.exec(part))) return { jobs: w.jobs[match[1]] ?? [] }
  throw new Error(`GET ${path} answered 404`)
}

const ask = (w, run = RUN) => verify(run, api(w))

describe('verify', () => {
  it('says yes for a squash of an up-to-date pull request whose run passed, and names the pull request, its head and the run', async () => {
    expect(await ask(world())).toEqual({ verified: true, reason: "#12's head head2 has this tree and passed qa in run 200", pull: 12, head: 'head2', run: 200 })
  })

  it('says yes for a merge commit too: its first parent is main as it was', async () => {
    const w = world()
    w.commits.merge2.parents = [{ sha: 'merge1' }, { sha: 'head2' }]
    expect((await ask(w)).verified).toBe(true)
  })

  it('only verifies a push to a branch, and needs the workflow and the gate', async () => {
    expect(await ask(world(), { ...RUN, event: 'workflow_dispatch' })).toEqual({ verified: false, reason: 'only a push can be verified, not a workflow_dispatch' })
    expect(await ask(world(), { ...RUN, ref: 'refs/tags/v1' })).toEqual({ verified: false, reason: 'refs/tags/v1 is not a branch' })
    expect((await ask(world(), { ...RUN, gate: '' })).verified).toBe(false)
    expect((await ask(world(), { ...RUN, workflow: '' })).verified).toBe(false)
  })

  it('says no for a push that is no pull request’s merge commit: a direct push', async () => {
    const w = world()
    w.pulls.merge2 = []
    expect(await ask(w)).toEqual({ verified: false, reason: 'merge2 is not the merge commit of a pull request into main' })
  })

  it('does not count a pull request that only holds the commit, one that is not merged, or one into another branch', async () => {
    for (const change of [{ merge_commit_sha: 'other' }, { merged_at: null }, { base: { ref: 'release' } }]) {
      const w = world()
      Object.assign(w.pulls.merge2[0], change)
      expect((await ask(w)).reason).toBe('merge2 is not the merge commit of a pull request into main')
    }
  })

  it('says no for a pull request from a fork', async () => {
    const w = world()
    w.pulls.merge2[0].head.repo.full_name = 'stranger/app'
    expect(await ask(w)).toEqual({ verified: false, reason: '#12 comes from another repository' })
  })

  it('says no when the merged tree is not the head’s: the branch was behind main when it merged', async () => {
    const w = world()
    w.commits.merge2.tree.sha = 'tree-with-more-of-main'
    expect(await ask(w)).toEqual({ verified: false, reason: '#12 merged as a tree its head head2 did not have: it was behind main, or changed in the merge' })
  })

  it('says no when the head did not hold all of main, even with the same tree: its run may have tested another merge', async () => {
    const w = world()
    w.behind['merge1...head2'] = 1
    expect(await ask(w)).toEqual({ verified: false, reason: "#12's head head2 did not hold every commit of main at merge1" })
  })

  it('says no when the head has no pull request run, or its newest one failed or has not finished', async () => {
    const none = world()
    none.runs = none.runs.filter(run => run.id !== 200)
    expect((await ask(none)).reason).toBe("ci.yml has no pull request run for #12's head head2")

    const failed = world()
    failed.runs.find(run => run.id === 200).conclusion = 'failure'
    expect((await ask(failed)).reason).toBe("the newest ci.yml run for #12's head (200) is failure, not success")

    const running = world()
    Object.assign(running.runs.find(run => run.id === 200), { status: 'in_progress', conclusion: null })
    expect((await ask(running)).reason).toBe("the newest ci.yml run for #12's head (200) is in_progress, not success")
  })

  it('goes by the newest run for the head: a later one that failed outweighs an earlier pass', async () => {
    const w = world()
    w.runs.push({ id: 201, head_sha: 'head2', event: 'pull_request', status: 'completed', conclusion: 'failure', created_at: '2026-11-17T09:45:00Z', head_repository: { full_name: REPO } })
    expect((await ask(w)).reason).toBe("the newest ci.yml run for #12's head (201) is failure, not success")
  })

  it('does not count a run from another repository for the same commit', async () => {
    const w = world()
    w.runs.find(run => run.id === 200).head_repository.full_name = 'stranger/app'
    expect((await ask(w)).reason).toBe("ci.yml has no pull request run for #12's head head2")
  })

  it('says no when the gate job was skipped, failed or is not in the run, though the run succeeded', async () => {
    const skipped = world()
    skipped.jobs[200] = [{ name: 'qa', status: 'completed', conclusion: 'skipped' }]
    expect((await ask(skipped)).reason).toBe('the qa job of run 200 ended as skipped, not success')

    const missing = world()
    missing.jobs[200] = [{ name: 'lint', status: 'completed', conclusion: 'success' }]
    expect((await ask(missing)).reason).toBe('run 200 has no job named qa')
  })

  it('says no when the push run of the commit before failed: main was not good underneath', async () => {
    const w = world()
    w.runs.find(run => run.id === 150).conclusion = 'failure'
    expect(await ask(w)).toEqual({ verified: false, reason: 'the commit before it is not verified: the ci.yml run for merge1 (150) ended as failure' })
  })

  it('takes the same evidence for the commit before while its push run has not finished', async () => {
    const w = world()
    Object.assign(w.runs.find(run => run.id === 150), { status: 'queued', conclusion: null })
    w.runs.push({ id: 90, head_sha: 'base', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-17T08:00:00Z', head_repository: { full_name: REPO } })
    expect((await ask(w)).verified).toBe(true)
  })

  it('says no when the commit before has neither a finished run nor the evidence, and stops looking at the depth it was given', async () => {
    const direct = world()
    direct.runs = direct.runs.filter(run => run.id !== 150)
    direct.pulls.merge1 = []
    expect((await ask(direct)).reason).toBe('the commit before it is not verified: merge1 is not the merge commit of a pull request into main')

    const shallow = world()
    shallow.runs = shallow.runs.filter(run => run.id !== 150)
    expect((await ask(shallow, { ...RUN, depth: 0 })).reason).toBe('the commit before it is not verified: the ci.yml run for merge1 has not finished, and that is as far back as this looks')
  })

  it('says no, with the reason, when GitHub cannot be read, and never throws', async () => {
    const w = world()
    delete w.commits.merge2
    expect(await ask(w)).toEqual({ verified: false, reason: `GitHub could not be read (GET /repos/${REPO}/git/commits/merge2 answered 404)` })
  })

  it('asks nothing of GitHub for a run that is not a push', async () => {
    const asked = []
    await verify({ ...RUN, event: 'pull_request' }, api(world(), asked))
    expect(asked).toEqual([])
  })
})

describe('latestRun and gatePassed', () => {
  it('latestRun is null when the workflow has no run for the commit', async () => {
    expect(await latestRun(api(world()), { repository: REPO, workflow: 'ci.yml', sha: 'nothing', event: 'push' })).toBeNull()
  })

  it('gatePassed reads the newest attempt’s jobs', async () => {
    const asked = []
    expect(await gatePassed(api(world(), asked), { repository: REPO, run: { id: 200 }, gate: 'qa' })).toEqual({ verified: true })
    expect(asked).toEqual([`/repos/${REPO}/actions/runs/200/jobs?filter=latest&per_page=100`])
  })
})
