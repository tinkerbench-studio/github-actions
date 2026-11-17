# github-actions

The GitHub Actions the tinkerbench-studio repositories share. Each began as a script in one repository that another had copied or needed; here there is one copy, with its tests.

| Action | What it does | Needs a checkout |
| --- | --- | --- |
| [`verified-tree`](verified-tree/action.yml) | Says whether the commit a push put on main holds exactly the files a pull request's CI already passed for, so the push's run can skip testing them again | No |
| [`changes`](changes/action.yml) | Lists the files a change touches and answers the repository's own yes-or-no questions about them, so a workflow starts only the jobs the change needs | Yes |
| [`migration-numbers`](migration-numbers/action.yml) | Checks that a folder of D1 migrations is numbered once each | Yes |
| [`node-install`](node-install/action.yml) | Installs `node_modules` with `npm ci`, or by hard-linking a tree a self-hosted runner already holds | Yes |
| [`node-install/warm-workerd`](node-install/warm-workerd/action.yml) | Reads workerd's binary through before the tests that start it | Yes |

Nothing here installs a package: the actions run on Node from a bare checkout of this repository, and the tests are `node --test`. All but `node-install` are JavaScript actions on the runner's own Node 24 (`using: node24`), which a self-hosted runner must be recent enough to have; `node-install` runs on the job's Node.

## Using one

Name the action by its folder and pin it to a commit, with the version in a comment, as the other actions in these repositories are pinned:

```yaml
- uses: tinkerbench-studio/github-actions/verified-tree@<commit sha> # v1.0.0
```

This repository is private. A workflow in another repository can use it once **Settings → Actions → General → Access** here is set to *Accessible from repositories in the tinkerbench-studio organization*.

## verified-tree

A merge queue that brings a pull request up to date before it merges has already tested the tree that lands on main. A squash gives main a new commit, so GitHub holds no pass for that commit, but its tree is the pull request head's. This action asks GitHub for that evidence. It never asks whether the queue did the merge: a merge that went round the queue has no such evidence and is tested in full, and one that has it is as safe as a queued one.

A commit is verified when all of these hold ([`verified-tree.mjs`](verified-tree/verified-tree.mjs)):

1. It is the merge commit of exactly one merged pull request into this branch, from a branch of this repository.
2. Its tree is the pull request head's tree.
3. The pull request's head held every commit of the branch as it stood before the merge.
4. The newest run of the workflow for that head is complete and succeeded, and in it the gate job succeeded. A skipped gate is not a pass.
5. The commit before it on the branch is verified too: its own push run succeeded, or, while that run has not finished, the same evidence holds for it.

Anything else, and anything GitHub cannot be asked, answers `verified: false` with the reason, and the run tests everything. The step never fails a job.

```yaml
permissions:
  contents: read
  pull-requests: read
  actions: read

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      verified: ${{ steps.tree.outputs.verified }}
    steps:
      - id: tree
        uses: tinkerbench-studio/github-actions/verified-tree@<commit sha>
        with:
          workflow: ci.yml # this workflow's file
          gate: qa # the job a pull request must pass

  tests:
    needs: changes
    if: ${{ needs.changes.outputs.verified != 'true' }}
```

What a workflow must keep true for this to be sound:

- **The gate job runs on every pull request and is not itself skipped on a pull request.** Jobs it `needs` may be skipped for a change that cannot affect them; point 5 covers those.
- **A push run that skips its tests still concludes `success`.** The next merge reads that run as "main was good" (point 5), and a workflow that deploys from the push run's success keeps doing so.
- **Whatever only the push run did still happens.** A baseline it uploaded, or a job that runs on main alone, needs another home or stays outside the `if`.
- **A run started by hand (`workflow_dispatch`) is never verified**, so it is the way to test main in full.

## changes

Each repository keeps its questions in one JSON file, so "documentation" is defined once there:

```json
{
  "outputs": {
    "docs_only": { "every": ["/docs/**", "*.md", "/.claude/**"], "except": ["/docs/**/*.test.ts"] },
    "storybook": { "any": ["/stories/**", "/components/**"] }
  }
}
```

- `every` is true when the change lists at least one file and every file matches a glob. A file an `except` glob matches does not count as matching.
- `any` is true when some file matches a glob and no `except` glob.
- A change that could not be listed (a push, a diff git cannot read) or that lists nothing is never guessed at: `every` answers false and `any` answers true, the answers that run the work. `"unlisted": true` or `false` on a question sets another.

The globs are the ones Tick-it's merge rules use ([`lib/glob.mjs`](lib/glob.mjs)): `*` stays inside a path segment, `**` crosses them, and a glob matches at any depth unless it starts with `/`.

```yaml
- uses: actions/checkout@<commit sha>
  with:
    fetch-depth: 0
- id: changes
  uses: tinkerbench-studio/github-actions/changes@<commit sha>
  with:
    config: .github/changes.json
    base: ${{ github.event_name == 'pull_request' && format('origin/{0}', github.base_ref) || '' }}
- if: ${{ steps.changes.outputs.docs_only != 'true' }}
  run: npm run typecheck
```

`first-parent: true` compares a pull request's merge commit with its first parent instead, which needs only `fetch-depth: 2`. The step also sets `listed`, `count` and `files-path`, a file with the changed files one a line, for a later step with questions a glob cannot answer.

## migration-numbers

```yaml
- uses: tinkerbench-studio/github-actions/migration-numbers@<commit sha>
  with:
    directory: apps/mcp/migrations
```

| Input | For |
| --- | --- |
| `directory` | The migrations folder; `migrations` when left out |
| `contiguous` | `true` to also require the numbers to run from 0001 with no gaps |
| `shared` | JSON naming the files allowed to share a number, for a clash that already ran everywhere: `{"0026": ["0026_a.sql", "0026_b.sql"]}` |
| `against`, `base` | Adds the migrations `against` (such as `origin/main`) gained since `base` (such as `HEAD^1`), so a pull request's run sees what merged after its merge commit was made |
| `pull-request-files` | A JSON file of a pull request's files as GitHub's API lists them, applied to the checkout: for checking open pull requests against the latest main |

[`migration-numbers.mjs`](migration-numbers/migration-numbers.mjs) imports nothing, so a repository's own test can run the same check.

## node-install

```yaml
- uses: actions/checkout@<commit sha>
- uses: tinkerbench-studio/github-actions/node-install@<commit sha>
  with:
    node-version: 22
    store: ${{ github.event_name == 'pull_request' && 'use' || 'never' }}
```

On a GitHub-hosted runner, and whenever `store` is not `use`, this is `npm ci`. On a self-hosted runner with `store: use` it keeps one prepared `node_modules` per lockfile and Node version under `<cache-dir>/node_modules` and hard-links it into the checkout, which writes directory entries and no file contents. Whatever goes wrong with the store, the job falls back to `npm ci` with a warning.

**Any job on a shared runner can write the store, so say `use` only for runs nothing trusts.** A push to `protected-ref` (main unless you name another) never links from the store or adds to it, whatever `store` says: that run is what a deploy trusts, so it installs from the lockfile. It does remove the stored trees of other lockfiles.

`npm-version` runs `ci` with that npm through `npx`, for a tree the runner's own npm cannot install. `node-auth-token` reaches npm as `NODE_AUTH_TOKEN`, for a private registry. Leave `node-version` and `node-version-file` out when the job has set Node up already.

## Changing an action

- `npm test` runs every `*.test.mjs`. CI runs them on Node 22 and 24, then uses each action once as a workflow would.
- A change here reaches no repository until that repository's pin moves, so a pull request there is what proves it.
- `verified-tree` decides what main's runs skip, and in a repository that deploys from that run, what is deployed without a second test. Review a change to it as you would a change to that deploy.
