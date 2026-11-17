# Working in github-actions

The actions the tinkerbench-studio repositories share (README.md says what each does and how a workflow uses it).

## Before a change goes to review

1. `npm test`: every `*.test.mjs`, with Node's own test runner
2. Run the action's entry point once by hand with its inputs in the environment (`INPUT_<NAME>`), since the tests call the functions and not `main.mjs`

## Conventions

- **No packages.** An action runs from a bare checkout of this repository, so nothing here is installed or bundled: Node's built-ins only, in the actions and in the tests (`lib/expect.mjs` gives the tests the few Vitest matchers they use).
- **One folder per action**, named as a workflow names it: `action.yml`, a `main.mjs` that reads inputs and sets outputs, the logic in a module beside it that takes what it reads from GitHub or git as an argument, and that module's test.
- **A JavaScript action (`using: node24`) unless the work must run on the job's own Node**, as `node-install` must: that one is composite.
- **Inputs go through the environment, never into a command line.**
- **An action that decides whether work is skipped answers no when it cannot tell**, and says why in one line. `verified-tree` and `changes` never guess.
- **Actions used inside an action are pinned to a commit**, with the version in a comment.
- **A changed input, output or default is a breaking change for every repository that pins the action**: update README.md and the `action.yml` descriptions in the same change, and say so in the pull request.
