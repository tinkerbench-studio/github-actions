import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, it } from 'node:test'

import { expect } from '../lib/expect.mjs'
import { CACHE, STALE_MS, installNodeModules, npmCommand, protectedRef, pruneStore, stateDifference, storeChoice, storeKey, summary, treeState, warmFiles, warmLine, warmWorkerd, workerdBinaries } from './install.mjs'

// TCK-1265: the checks job links a prepared node_modules from the runner's store, and runs npm ci when it cannot. These tests use real folders and real hard links.

const made = []
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-install-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SELF_HOSTED = { RUNNER_ENVIRONMENT: 'self-hosted', NODE_INSTALL_STORE: 'use', RUNNER_NAME: 'runner-1', GITHUB_RUN_ID: '42', GITHUB_JOB: 'checks' }
const PACKAGE = JSON.stringify({ allowScripts: { 'esbuild@1': true } })

/** A checkout with a lockfile, in a folder of its own. */
const checkout = (lockfile = 'lock 1', packageJson = PACKAGE) => {
  const cwd = folder()
  writeFileSync(join(cwd, 'package-lock.json'), lockfile)
  writeFileSync(join(cwd, 'package.json'), packageJson)
  return cwd
}
/** Stands in for npm ci: writes a small tree, as npm does (writable files, a link in .bin), and counts its runs. */
const npm = () => {
  const run = (cwd) => {
    run.runs += 1
    mkdirSync(join(cwd, 'node_modules/a/lib'), { recursive: true })
    mkdirSync(join(cwd, 'node_modules/.bin'))
    writeFileSync(join(cwd, 'node_modules/a/index.js'), 'a')
    writeFileSync(join(cwd, 'node_modules/a/lib/b.js'), 'bb')
    chmodSync(join(cwd, 'node_modules/a/lib/b.js'), 0o755)
    symlinkSync('../a/index.js', join(cwd, 'node_modules/.bin/a'))
  }
  run.runs = 0
  return run
}
const install = (cwd, cache, options = {}) => installNodeModules({ cwd, cache, env: SELF_HOSTED, ...options })
const inode = (path) => statSync(path).ino
const mode = (path) => statSync(path).mode & 0o777

describe('storeChoice', () => {
  const yes = () => true
  it('stores under /ci/cache/node_modules on a self-hosted runner that has a /ci/cache to write to', () => {
    expect(CACHE).toBe('/ci/cache')
    expect(storeChoice({ env: SELF_HOSTED, writable: yes })).toEqual({ root: '/ci/cache/node_modules', why: null })
  })

  it('has no store on a GitHub-hosted runner, off CI, or without a /ci/cache that can be written to, and says why', () => {
    expect(storeChoice({ env: { RUNNER_ENVIRONMENT: 'github-hosted' }, writable: yes })).toEqual({ root: null, why: 'a GitHub-hosted runner starts empty' })
    expect(storeChoice({ env: {}, writable: yes })).toEqual({ root: null, why: 'not a self-hosted runner' })
    expect(storeChoice({ env: SELF_HOSTED, writable: () => false })).toEqual({ root: null, why: 'there is no /ci/cache to write to' })
    // The real probe: a folder that is not there, and a file where the folder should be.
    const dir = folder()
    writeFileSync(join(dir, 'file'), '')
    expect(storeChoice({ env: SELF_HOSTED, cache: join(dir, 'missing') }).root).toBeNull()
    expect(storeChoice({ env: SELF_HOSTED, cache: join(dir, 'file') }).root).toBeNull()
    expect(storeChoice({ env: SELF_HOSTED, cache: dir }).root).toBe(join(dir, 'node_modules'))
  })
})

describe('storeKey', () => {
  const base = { lockfile: 'lock 1', packageJson: PACKAGE, node: 'v22.11.0', platform: 'linux', arch: 'x64' }
  it('names the layout, the platform and the Node version, and is the same for the same lockfile', () => {
    expect(storeKey(base)).toMatch(/^v1-linux-x64-node22\.11\.0-[0-9a-f]{32}$/)
    expect(storeKey({ ...base })).toBe(storeKey(base))
  })

  it('changes with the lockfile, the Node version, the platform and the install scripts package.json allows, and with nothing else in package.json', () => {
    const key = storeKey(base)
    expect(storeKey({ ...base, lockfile: 'lock 2' })).not.toBe(key)
    expect(storeKey({ ...base, node: 'v22.12.0' })).not.toBe(key)
    expect(storeKey({ ...base, arch: 'arm64' })).not.toBe(key)
    expect(storeKey({ ...base, packageJson: JSON.stringify({ allowScripts: { 'esbuild@2': true } }) })).not.toBe(key)
    expect(storeKey({ ...base, packageJson: JSON.stringify({ scripts: { test: 'vitest' }, allowScripts: { 'esbuild@1': true } }) })).toBe(key)
  })
})

describe('installNodeModules', () => {
  it('runs npm ci and stores nothing on a GitHub-hosted runner or without a /ci/cache', () => {
    const cache = folder()
    for (const options of [{ env: { RUNNER_ENVIRONMENT: 'github-hosted' } }, { cache: join(cache, 'missing') }]) {
      const run = npm()
      const cwd = checkout()
      const result = install(cwd, cache, { install: run, ...options })
      expect(result).toMatchObject({ how: 'installed', key: null, changed: null, warnings: [], storeMb: null })
      expect(result.why).not.toBeNull()
      expect(run.runs).toBe(1)
      expect(readFileSync(join(cwd, 'node_modules/a/index.js'), 'utf8')).toBe('a')
      expect(readdirSync(cache)).toEqual([])
    }
  })

  it('runs npm ci and stores the tree when none is stored, then links it into the next checkout without npm', () => {
    const cache = folder()
    const run = npm()
    const first = checkout()
    const stored = install(first, cache, { install: run })
    expect(stored).toMatchObject({ how: 'stored', files: 3, changed: null, warnings: [] })
    expect(run.runs).toBe(1)
    const entry = join(cache, 'node_modules', stored.key)
    expect(readdirSync(join(cache, 'node_modules'))).toEqual([stored.key])
    expect(JSON.parse(readFileSync(join(entry, 'manifest.json'), 'utf8'))).toMatchObject({ key: stored.key, files: 3, bytes: 3, storedBy: 'run 42 (checks) on runner-1' })

    const second = checkout()
    const linked = install(second, cache, { install: run })
    expect(linked).toMatchObject({ how: 'linked', files: 3, changed: [], warnings: [], key: stored.key })
    expect(run.runs).toBe(1)
    // The same files, not copies: a hard link shares the inode. The link in .bin is still a link, and folders are the checkout's own.
    for (const file of ['a/index.js', 'a/lib/b.js']) expect(inode(join(second, 'node_modules', file))).toBe(inode(join(entry, 'node_modules', file)))
    expect(readFileSync(join(second, 'node_modules/.bin/a'), 'utf8')).toBe('a')
    expect(inode(join(second, 'node_modules/a'))).not.toBe(inode(join(entry, 'node_modules/a')))
    expect(readFileSync(join(entry, 'last-used'), 'utf8')).toContain('run 42 (checks) on runner-1')
  })

  it('makes the stored files read-only and keeps what a mode had beyond writing; a job’s new entries stay in its checkout', () => {
    const cache = folder()
    const first = checkout()
    const { key } = install(first, cache, { install: npm() })
    const tree = join(cache, 'node_modules', key, 'node_modules')
    expect(mode(join(tree, 'a/index.js')) & 0o222).toBe(0)
    expect(mode(join(tree, 'a/lib/b.js'))).toBe(0o555)
    // The checkout that installed has the same files, so they are read-only there too.
    expect(mode(join(first, 'node_modules/a/index.js')) & 0o222).toBe(0)

    const second = checkout()
    install(second, cache, { install: npm() })
    mkdirSync(join(second, 'node_modules/.vite'))
    writeFileSync(join(second, 'node_modules/.vite/deps.json'), '{}')
    writeFileSync(join(second, 'node_modules/a/new.js'), 'new')
    expect(existsSync(join(tree, '.vite'))).toBe(false)
    expect(existsSync(join(tree, 'a/new.js'))).toBe(false)
    // Removing the checkout's tree, as the next job's checkout does, leaves the stored one whole.
    rmSync(join(second, 'node_modules'), { recursive: true })
    expect(install(checkout(), cache, { install: npm() })).toMatchObject({ how: 'linked', changed: [] })
  })

  it('finds a stored file a job changed, warns with its path and who used the tree last, removes the tree and installs afresh', () => {
    const cache = folder()
    const run = npm()
    const { key } = install(checkout(), cache, { install: run })
    const job = checkout()
    install(job, cache, { install: run })
    // A job writes into a dependency through its linked copy: it has to make the file writable first.
    chmodSync(join(job, 'node_modules/a/index.js'), 0o644)
    writeFileSync(join(job, 'node_modules/a/index.js'), 'changed')

    const next = checkout()
    const result = install(next, cache, { install: run })
    expect(result.changed).toEqual(['a/index.js'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('1 stored file(s) changed since run 42 (checks) on runner-1 stored them (last used by run 42 (checks) on runner-1 at ')
    expect(result.warnings[0]).toContain('a/index.js')
    // npm ran again and its tree, not the changed one, is what the checkout and the store now hold.
    expect(run.runs).toBe(2)
    expect(result).toMatchObject({ how: 'stored', key })
    expect(readFileSync(join(next, 'node_modules/a/index.js'), 'utf8')).toBe('a')
    expect(readFileSync(join(cache, 'node_modules', key, 'node_modules/a/index.js'), 'utf8')).toBe('a')
    expect(inode(join(next, 'node_modules/a/index.js'))).not.toBe(inode(join(job, 'node_modules/a/index.js')))
    expect(install(checkout(), cache, { install: run })).toMatchObject({ how: 'linked', changed: [] })
  })

  it('finds a mode change alone, and a file added to or removed from the stored tree', () => {
    const cache = folder()
    const { key } = install(checkout(), cache, { install: npm() })
    const tree = join(cache, 'node_modules', key, 'node_modules')
    chmodSync(join(tree, 'a/index.js'), 0o644)
    writeFileSync(join(tree, 'a/extra.js'), '')
    rmSync(join(tree, 'a/lib/b.js'))
    expect(install(checkout(), cache, { install: npm() }).changed).toEqual(['a/extra.js', 'a/index.js', 'a/lib/b.js'])
  })

  it('uses a tree only for its own lockfile: another lockfile installs and is stored beside it', () => {
    const cache = folder()
    const run = npm()
    const one = install(checkout('lock 1'), cache, { install: run })
    const two = install(checkout('lock 2'), cache, { install: run })
    expect(two).toMatchObject({ how: 'stored', why: 'no tree is stored for this lockfile and Node version' })
    expect(two.key).not.toBe(one.key)
    expect(run.runs).toBe(2)
    expect(readdirSync(join(cache, 'node_modules')).sort()).toEqual([one.key, two.key].sort())
  })

  it('falls back to npm ci with a warning when the stored tree cannot be linked, and never fails for it', () => {
    const cache = folder()
    const run = npm()
    install(checkout(), cache, { install: run })
    const cwd = checkout()
    const result = install(cwd, cache, {
      install: run,
      link: (_from, to) => {
        // Half a tree, then the failure a second filesystem gives.
        mkdirSync(join(to, 'a'), { recursive: true })
        writeFileSync(join(to, 'a/half.js'), '')
        throw new Error('cp: cannot create hard link: Invalid cross-device link')
      },
    })
    expect(result).toMatchObject({ how: 'installed', why: 'the stored tree could not be used' })
    expect(result.warnings).toEqual(['the stored tree could not be used (cp: cannot create hard link: Invalid cross-device link), so npm ci runs instead'])
    expect(run.runs).toBe(2)
    // The half-linked tree went before npm ran.
    expect(existsSync(join(cwd, 'node_modules/a/half.js'))).toBe(false)
    expect(readFileSync(join(cwd, 'node_modules/a/index.js'), 'utf8')).toBe('a')
  })

  it('still installs, with a warning, when the tree cannot be stored, and leaves nothing half-made in the store', () => {
    const cache = folder()
    // The store's folder is a file, so nothing can be made in it.
    writeFileSync(join(cache, 'node_modules'), '')
    const run = npm()
    const cwd = checkout()
    const result = install(cwd, cache, { install: run })
    expect(result.how).toBe('installed')
    expect(result.warnings.some(warning => warning.startsWith('the installed tree could not be stored ('))).toBe(true)
    expect(run.runs).toBe(1)
    expect(readFileSync(join(cwd, 'node_modules/a/index.js'), 'utf8')).toBe('a')
  })

  it('removes a stored tree whose record is missing or unreadable, with a warning, and stores a whole one in its place', () => {
    const cache = folder()
    const run = npm()
    const { key } = install(checkout(), cache, { install: run })
    const entry = join(cache, 'node_modules', key)
    for (const damage of [() => rmSync(join(entry, 'manifest.json')), () => writeFileSync(join(entry, 'manifest.json'), '{'), () => rmSync(join(entry, 'state.txt'))]) {
      damage()
      const before = run.runs
      const result = install(checkout(), cache, { install: run })
      expect(result).toMatchObject({ how: 'stored', key, changed: null })
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toMatch(/^the stored tree has no record that can be read \(.+\), so it is removed and installed afresh$/)
      expect(run.runs).toBe(before + 1)
      expect(install(checkout(), cache, { install: run })).toMatchObject({ how: 'linked', changed: [], warnings: [] })
    }
    expect(readdirSync(join(cache, 'node_modules'))).toEqual([key])
  })

  // Jobs run in containers of their own that share the store, so two can have the same process id: a folder named by it would be one job's to remove while the other fills it.
  it('makes and removes its folders under names of its own, so a job with the same process id cannot take them, and leaves another job’s half-made folder alone', () => {
    const cache = folder()
    const run = npm()
    const lock = checkout()
    const key = storeKey({ lockfile: readFileSync(join(lock, 'package-lock.json')), packageJson: PACKAGE })
    // Another job, with this process's id, is halfway through storing the same key.
    const other = join(cache, 'node_modules', `.making-${key}-${process.pid}`)
    mkdirSync(join(other, 'node_modules'), { recursive: true })
    writeFileSync(join(other, 'node_modules/half.js'), '')
    expect(install(lock, cache, { install: run })).toMatchObject({ how: 'stored', key, warnings: [] })
    expect(readFileSync(join(other, 'node_modules/half.js'), 'utf8')).toBe('')
    expect(readdirSync(join(cache, 'node_modules')).sort()).toEqual([`.making-${key}-${process.pid}`, key].sort())
    expect(existsSync(join(cache, 'node_modules', key, 'manifest.json'))).toBe(true)
  })

  it('keeps the tree another job stored first when both installed the same key at once', () => {
    const cache = folder()
    const first = npm()
    const lock = checkout()
    // While this job's npm ci runs, another job stores the same key.
    const racing = (cwd) => {
      first(cwd)
      install(checkout(), cache, { install: npm() })
    }
    const result = install(lock, cache, { install: racing })
    expect(result.how).toBe('installed')
    // Nothing went wrong: the other job's tree is the one kept, and this job's own install is what its checkout has.
    expect(result.warnings).toEqual([])
    expect(inode(join(lock, 'node_modules/a/index.js'))).not.toBe(inode(join(cache, 'node_modules', result.key, 'node_modules/a/index.js')))
    expect(readdirSync(join(cache, 'node_modules'))).toEqual([result.key])
    expect(install(checkout(), cache, { install: npm() })).toMatchObject({ how: 'linked', changed: [] })
  })

  it('lets a failed npm ci through: the job fails as it did before', () => {
    const cache = folder()
    const failing = () => {
      throw Object.assign(new Error('npm ci failed (exit 137)'), { exitCode: 137 })
    }
    expect(() => install(checkout(), cache, { install: failing })).toThrow('npm ci failed (exit 137)')
    expect(() => install(checkout(), cache, { install: failing, env: {} })).toThrow('npm ci failed (exit 137)')
    expect(readdirSync(cache)).toEqual([])
  })

  it('removes the trees of other lockfiles on a push to main, and on nothing else', () => {
    const cache = folder()
    const run = npm()
    const old = install(checkout('lock 1'), cache, { install: run })
    const pull = { ...SELF_HOSTED, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' }
    const branch = { ...SELF_HOSTED, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/other' }
    expect(install(checkout('lock 2'), cache, { install: run, env: pull }).removed).toEqual([])
    expect(install(checkout('lock 2'), cache, { install: run, env: branch }).removed).toEqual([])
    expect(readdirSync(join(cache, 'node_modules'))).toHaveLength(2)

    const main = { ...SELF_HOSTED, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }
    const result = install(checkout('lock 2'), cache, { install: run, env: main })
    // A push to main installs in full (it never links from the store, TCK-1354), and only deletes from it.
    expect(result).toMatchObject({ how: 'installed', removed: [old.key] })
    expect(readdirSync(join(cache, 'node_modules'))).toHaveLength(1)
  })
})

describe('pruneStore', () => {
  it('keeps the named tree and a folder a job is still making, and removes the rest, a stale half-made folder included', () => {
    const root = folder()
    for (const name of ['keep', 'old-1', 'old-2', '.making-new-1', '.making-dead-2', '.removing-dead-3']) {
      mkdirSync(join(root, name, 'node_modules'), { recursive: true })
      writeFileSync(join(root, name, 'node_modules/file.js'), '')
      chmodSync(join(root, name, 'node_modules/file.js'), 0o444)
    }
    const now = Date.now()
    const long = new Date(now - STALE_MS - 1000)
    for (const name of ['.making-dead-2', '.removing-dead-3']) utimesSync(join(root, name), long, long)
    expect(pruneStore({ root, key: 'keep', now: () => now }).sort()).toEqual(['.making-dead-2', '.removing-dead-3', 'old-1', 'old-2'])
    expect(readdirSync(root).sort()).toEqual(['.making-new-1', 'keep'])
  })
})

describe('treeState and stateDifference', () => {
  it('records a file’s size, time and mode and a link’s target, reading no contents, in the same order each time', () => {
    const cwd = checkout()
    npm()(cwd)
    const { lines, bytes } = treeState(join(cwd, 'node_modules'))
    expect(bytes).toBe(3)
    expect(lines.map((line) => line.split('\t')[0])).toEqual(['.bin/a', 'a/index.js', 'a/lib/b.js'])
    expect(lines[0]).toBe('.bin/a\t-> ../a/index.js')
    expect(lines[2]).toMatch(/^a\/lib\/b\.js\t2\t\d+\t755$/)
    expect(treeState(join(cwd, 'node_modules')).lines).toEqual(lines)
  })

  it('names the paths that changed, were added or were removed', () => {
    expect(stateDifference(['a\t1\t5\t444', 'b\t1\t5\t444', 'c\t-> a'], ['a\t1\t5\t444', 'b\t1\t6\t444', 'd\t1\t5\t444'])).toEqual(['b', 'c', 'd'])
    expect(stateDifference(['a\t1\t5\t444'], ['a\t1\t5\t444'])).toEqual([])
  })
})

// TCK-1324: the step before the small projects reads workerd's binary through, so its first start does not read it from a cold disk inside Vitest's 90 s runner start limit.
describe('workerdBinaries, warmFiles and warmWorkerd', () => {
  it('finds the workerd binary of each platform package installed, and none in a tree without one', () => {
    const modules = folder()
    expect(workerdBinaries(modules)).toEqual([])
    for (const name of ['workerd-linux-arm64', 'workerd-linux-64', 'workers-types']) mkdirSync(join(modules, '@cloudflare', name, 'bin'), { recursive: true })
    writeFileSync(join(modules, '@cloudflare/workerd-linux-arm64/bin/workerd'), 'a')
    writeFileSync(join(modules, '@cloudflare/workerd-linux-64/bin/workerd'), 'b')
    writeFileSync(join(modules, '@cloudflare/workers-types/bin/workerd'), 'not a binary package')
    expect(workerdBinaries(modules)).toEqual([join(modules, '@cloudflare/workerd-linux-64/bin/workerd'), join(modules, '@cloudflare/workerd-linux-arm64/bin/workerd')])
  })

  it('reads every byte of each file, past one buffer, and skips one that cannot be read', () => {
    const dir = folder()
    const big = join(dir, 'big')
    writeFileSync(big, Buffer.alloc(9 * 1024 * 1024 + 7, 1))
    writeFileSync(join(dir, 'small'), 'abc')
    expect(warmFiles([big, join(dir, 'small'), join(dir, 'missing'), dir])).toEqual({ files: 2, bytes: 9 * 1024 * 1024 + 10 })
  })

  it('reads the workerd binary of a node_modules tree, times the read, and says in one line what it read and how long it took', () => {
    const modules = folder()
    mkdirSync(join(modules, '@cloudflare/workerd-linux-64/bin'), { recursive: true })
    writeFileSync(join(modules, '@cloudflare/workerd-linux-64/bin/workerd'), 'w'.repeat(5000))
    const times = [1000, 42230]
    expect(warmWorkerd({ modules, now: () => times.shift() })).toEqual({ files: 1, bytes: 5000, ms: 41230 })
    expect(warmWorkerd({ modules: folder() })).toMatchObject({ files: 0, bytes: 0 })
    expect(warmLine({ files: 1, bytes: 135176688, ms: 41230 })).toBe('workerd: read 1 file(s), 129 MB, in 41.2 s')
    expect(warmLine({ files: 0, bytes: 0, ms: 0 })).toBe('workerd: no binary to read in node_modules')
  })
})

describe('summary', () => {
  const result = { how: 'linked', why: null, key: 'v1-key', files: 16460, changed: [], removed: [], storeMb: 512, warnings: [], ms: 1840 }
  const where = { env: { RUNNER_NAME: 'runner-1' }, host: 'pve-01' }
  it('says in one line what was done, how long it took, on which runner and host, and what the store uses', () => {
    expect(summary(result, where)).toBe('node_modules: linked 16460 stored files in 1.8 s; runner runner-1 on pve-01; key v1-key; stored files unchanged; the store uses 512 MB')
    expect(summary({ ...result, how: 'stored', changed: ['a'], removed: ['old'], ms: 61000 }, where)).toBe('node_modules: ran npm ci and stored 16460 files in 61.0 s; runner runner-1 on pve-01; key v1-key; 1 stored file(s) had changed; removed 1 old tree(s); the store uses 512 MB')
    expect(summary({ ...result, how: 'installed', why: 'a GitHub-hosted runner starts empty', key: null, changed: null, storeMb: null }, { env: {}, host: 'fv-az1' })).toBe('node_modules: ran npm ci (a GitHub-hosted runner starts empty) in 1.8 s; runner unknown on fv-az1')
  })
})

describe('the settings a workflow gives', () => {
  it('uses the store only when told to', () => {
    const writable = () => true
    expect(storeChoice({ env: { ...SELF_HOSTED, NODE_INSTALL_STORE: 'never' }, writable }).root).toBeNull()
    expect(storeChoice({ env: { RUNNER_ENVIRONMENT: 'self-hosted' }, writable })).toEqual({ root: null, why: 'the workflow does not use the store for this run (store is not use)' })
  })

  it('never uses the store for a push to the protected ref, which is main unless the workflow names another', () => {
    const writable = () => true
    const push = { ...SELF_HOSTED, GITHUB_EVENT_NAME: 'push' }
    expect(protectedRef({})).toBe('refs/heads/main')
    expect(storeChoice({ env: { ...push, GITHUB_REF: 'refs/heads/main' }, writable })).toEqual({ root: null, why: 'a push to refs/heads/main is what a deploy trusts, so it never installs from the store other jobs can write' })
    expect(storeChoice({ env: { ...push, GITHUB_REF: 'refs/heads/feature' }, writable }).root).not.toBeNull()
    const trunk = { ...push, NODE_INSTALL_PROTECTED_REF: 'refs/heads/trunk' }
    expect(storeChoice({ env: { ...trunk, GITHUB_REF: 'refs/heads/trunk' }, writable }).root).toBeNull()
    expect(storeChoice({ env: { ...trunk, GITHUB_REF: 'refs/heads/main' }, writable }).root).not.toBeNull()
  })

  it('runs the npm on the PATH, or the version the workflow names through npx', () => {
    expect(npmCommand({})).toEqual(['npm', ['ci']])
    expect(npmCommand({ NODE_INSTALL_NPM_VERSION: '11.21.2' })).toEqual(['npx', ['-y', 'npm@11.21.2', 'ci']])
  })

  it('reads the cache folder from the environment and hands the environment to the install', () => {
    const cache = folder()
    const cwd = checkout()
    const env = { ...SELF_HOSTED, NODE_INSTALL_CACHE: cache }
    const seen = []
    const fake = npm()
    const result = installNodeModules({ cwd, env, install: (dir, given) => (seen.push(given), fake(dir)) })
    expect(result.how).toBe('stored')
    expect(existsSync(join(cache, 'node_modules', result.key))).toBe(true)
    expect(seen).toEqual([env])
  })
})
