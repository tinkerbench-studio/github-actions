import { describe, it } from 'node:test'

import { expect } from '../lib/expect.mjs'
import { gainedSince, migrationName, numberingProblems, withPullRequest } from './migration-numbers.mjs'

describe('numberingProblems', () => {
  it('finds nothing wrong with numbers used once each, in any order, and counts a name given twice once', () => {
    expect(numberingProblems(['0002_b.sql', '0001_a.sql', '0001_a.sql'])).toEqual([])
  })

  it('names a number two files take, and both files', () => {
    expect(numberingProblems(['0001_a.sql', '0002_b.sql', '0002_c.sql'])).toEqual(['0002 is taken by 0002_b.sql and 0002_c.sql. Renumber the one that has not merged to the next free number.'])
  })

  it('names a file that is not NNNN_snake_case.sql', () => {
    expect(numberingProblems(['1_a.sql', '0002_B.sql', '0003-c.sql'])).toEqual(['0002_B.sql is not named NNNN_snake_case.sql.', '0003-c.sql is not named NNNN_snake_case.sql.', '1_a.sql is not named NNNN_snake_case.sql.'])
  })

  it('allows gaps unless told the numbers are contiguous, and then names the first one missing', () => {
    expect(numberingProblems(['0001_a.sql', '0003_c.sql'])).toEqual([])
    expect(numberingProblems(['0001_a.sql', '0003_c.sql'], { contiguous: true })).toEqual(['0002 is missing: migrations run from 0001 with no gaps.'])
    expect(numberingProblems(['0002_b.sql'], { contiguous: true })).toEqual(['0001 is missing: migrations run from 0001 with no gaps.'])
  })

  it('lets exactly the named files share a number, in whatever order they are named', () => {
    const shared = { '0026': ['0026_support_history.sql', '0026_derived_countries.sql'] }
    expect(numberingProblems(['0026_derived_countries.sql', '0026_support_history.sql'], { shared })).toEqual([])
    expect(numberingProblems(['0026_derived_countries.sql', '0026_support_history.sql', '0026_third.sql'], { shared })).toHaveLength(1)
    expect(numberingProblems(['0026_derived_countries.sql', '0026_other.sql'], { shared })).toHaveLength(1)
  })

  it('a shared number still counts once for the gap check', () => {
    const names = ['0001_a.sql', '0002_b.sql', '0002_c.sql', '0003_d.sql']
    expect(numberingProblems(names, { contiguous: true, shared: { '0002': ['0002_b.sql', '0002_c.sql'] } })).toEqual([])
  })
})

describe('gainedSince', () => {
  it('is what the later list holds that the earlier did not; a file since renamed or removed is not counted', () => {
    expect(gainedSince(['0001_a.sql', '0002_old.sql'], ['0001_a.sql', '0002_new.sql', '0003_c.sql'])).toEqual(['0002_new.sql', '0003_c.sql'])
  })
})

describe('migrationName', () => {
  it('is the file name of a .sql file directly inside the folder', () => {
    expect(migrationName('migrations/0001_a.sql')).toBe('0001_a.sql')
    expect(migrationName('apps/mcp/migrations/0001_a.sql', 'apps/mcp/migrations/')).toBe('0001_a.sql')
  })

  it('is undefined for any other path', () => {
    for (const file of ['migrations/README.md', 'other/0001_a.sql', 'migrations/old/0001_a.sql', 'migrations-2/0001_a.sql', '']) expect(migrationName(file)).toBe(undefined)
  })
})

describe('withPullRequest', () => {
  const main = ['0001_a.sql', '0002_b.sql']

  it('adds the migrations a pull request adds, so a number main took since shows as a clash', () => {
    const names = withPullRequest(main, [{ filename: 'migrations/0002_mine.sql', status: 'added' }, { filename: 'src/a.ts', status: 'modified' }])
    expect(names).toEqual(['0001_a.sql', '0002_b.sql', '0002_mine.sql'])
    expect(numberingProblems(names)).toHaveLength(1)
  })

  it('drops a migration the pull request removes, and the old name of one it renames', () => {
    expect(withPullRequest(main, [{ filename: 'migrations/0002_b.sql', status: 'removed' }])).toEqual(['0001_a.sql'])
    expect(withPullRequest(main, [{ filename: 'migrations/0003_b.sql', status: 'renamed', previous_filename: 'migrations/0002_b.sql' }])).toEqual(['0001_a.sql', '0003_b.sql'])
  })

  it('reads another folder when told', () => {
    expect(withPullRequest([], [{ filename: 'apps/mcp/migrations/0001_a.sql', status: 'added' }], 'apps/mcp/migrations')).toEqual(['0001_a.sql'])
  })
})
