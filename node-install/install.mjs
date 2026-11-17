/**
 * Installs node_modules for one CI job, from a prepared tree on the runner when there is one. Tick-it wrote this (scripts/ci-install.mjs there, TCK-1265); this is
 * the one copy, with what was particular to that repository made an input.
 *
 * `npm ci` writes every dependency file again in every job: hundreds of megabytes and tens of thousands of files, on a disk the runners of a host share.
 * Hard-linking a tree that is already on the disk writes directory entries and no file contents. So a self-hosted runner keeps one prepared node_modules per
 * lockfile and Node version under <cache>/node_modules, the folder that carries over from one job to the next:
 *
 * - With a tree stored for this lockfile and Node version, it is linked into the checkout (`cp -al`), and npm does not run.
 * - With none, `npm ci` runs as before and its result is linked into the store for the next job.
 * - On a GitHub-hosted runner, or where there is no cache folder to write to, `npm ci` runs as before and nothing is stored.
 * - Whatever goes wrong with the store (another filesystem, so no hard link; a full disk; a tree another job is removing), the job falls
 *   back to `npm ci` and says so in a warning: the store can make a job faster, never fail it.
 *
 * A linked file is the stored file, so a write into it would change it for every later job. The stored files are made read-only, and the
 * store keeps each file's size, modification time and mode: before a tree is used it is compared with that record, and a tree with any
 * difference is reported in a warning, removed and installed afresh. That catches an accident, not an attack: a job can make a file
 * writable and set its time back.
 *
 * So the store is opt-in, and never for a push to the protected branch (TCK-1354): any job on shared runners can write it, and a push to main's run is what a
 * deploy trusts. The workflow says `store: use` for the runs that may (a pull request's) and the script refuses a push to the protected ref whatever it is told:
 * that run installs from the lockfile with `npm ci` (npm's own cache is content-addressed, so a file in it that does not match its hash is refused). It still
 * removes the trees of other lockfiles, which only deletes, so trees for lockfiles no longer on the branch do not pile up.
 *
 * `node install.mjs --warm-workerd` reads workerd's binary (about 130 MB) through once and prints how long that took (TCK-1324).
 * A linked tree's files were written by an earlier job, so they may no longer be in the host's page cache, and the binary is then read
 * from the disk the first time a test project starts it, inside the 90 s Vitest gives a runner to start. Run it as the step just before the tests that start
 * workerd, not at install: the steps in between can push the binary out of the cache again.
 *
 * Every install ends with one line that says what it did, how long it took, on which runner, and how much disk the store uses, in the log and in the job's summary.
 *
 * Its settings come from the environment, which action.yml sets from the inputs: NODE_INSTALL_STORE (`use` or `never`), NODE_INSTALL_CACHE (the folder that
 * carries over), NODE_INSTALL_PROTECTED_REF, NODE_INSTALL_NPM_VERSION (an npm to run `ci` with through npx; the one on the PATH when empty) and
 * NODE_INSTALL_AUTH_TOKEN (handed to npm as NODE_AUTH_TOKEN, when given).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, appendFileSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The branch whose pushes never use the store. */
export const protectedRef = env => env.NODE_INSTALL_PROTECTED_REF || 'refs/heads/main'

const isMainPush = env => env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === protectedRef(env)

/** The runner's folder that carries over from one job to the next, unless NODE_INSTALL_CACHE names another. */
export const CACHE = '/ci/cache'
/** The stored trees' folder inside it, one folder per key. */
export const STORE = 'node_modules'
/** Part of every key: a change to how a tree is stored changes it, so trees stored the old way are not used (and a push to the protected branch removes them). */
export const LAYOUT = 'v1'
/** A folder a job that was killed left half-made is removed once it is this old; a job that is still making one is far younger. */
export const STALE_MS = 60 * 60 * 1000

const canWrite = dir => {
  try {
    accessSync(dir, constants.W_OK | constants.X_OK)
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * Where this job's stored trees are: `root` is the folder, or null to run `npm ci` as before, and `why` says why not.
 * Only a self-hosted runner has a store: GitHub sets RUNNER_ENVIRONMENT to github-hosted or self-hosted in every job.
 */
export const storeChoice = ({ env = process.env, cache = CACHE, writable = canWrite } = {}) => {
  if (env.RUNNER_ENVIRONMENT !== 'self-hosted') return { root: null, why: env.RUNNER_ENVIRONMENT === 'github-hosted' ? 'a GitHub-hosted runner starts empty' : 'not a self-hosted runner' }
  if (isMainPush(env)) return { root: null, why: `a push to ${protectedRef(env)} is what a deploy trusts, so it never installs from the store other jobs can write` }
  if (env.NODE_INSTALL_STORE !== 'use') return { root: null, why: 'the workflow does not use the store for this run (store is not use)' }
  if (!writable(cache)) return { root: null, why: `there is no ${cache} to write to` }
  return { root: join(cache, STORE), why: null }
}

/**
 * The name of the stored tree for what `npm ci` would install here: the lockfile, the install scripts package.json allows (allowScripts
 * decides whether workerd's and esbuild's run, and can change without the lockfile), the Node version and the machine's platform.
 */
export const storeKey = ({ lockfile, packageJson, node = process.version, platform = process.platform, arch = process.arch }) => {
  const allowScripts = JSON.stringify(JSON.parse(packageJson).allowScripts ?? null)
  const hash = createHash('sha256').update(lockfile).update('\0').update(allowScripts).digest('hex').slice(0, 32)
  return `${LAYOUT}-${platform}-${arch}-node${node.replace(/^v/, '')}-${hash}`
}

/** Every entry under `dir` but the folders themselves, as [path from dir, lstat] in a fixed order. */
function* entries(dir, under = '') {
  for (const name of readdirSync(join(dir, under)).sort()) {
    const path = under ? `${under}/${name}` : name
    const stat = lstatSync(join(dir, path), { bigint: true })
    if (stat.isDirectory()) yield* entries(dir, path)
    else yield [path, stat]
  }
}

/**
 * What a tree holds, a line per file or link: a file's size, modification time (ns) and mode, a link's target. No contents are read, so
 * it costs a stat per file. A write into a file changes its size or time, and making it writable changes its mode.
 */
export const treeState = dir => {
  const lines = []
  let bytes = 0n
  for (const [path, stat] of entries(dir)) {
    if (stat.isSymbolicLink()) lines.push(`${path}\t-> ${readlinkSync(join(dir, path))}`)
    else {
      lines.push(`${path}\t${stat.size}\t${stat.mtimeNs}\t${(stat.mode & 0o7777n).toString(8)}`)
      bytes += stat.size
    }
  }
  return { lines, bytes: Number(bytes) }
}

/** The paths whose line differs between two states (changed, added or removed), in order. */
export const stateDifference = (before, after) => {
  const was = new Map(before.map(line => [line.slice(0, line.indexOf('\t')), line]))
  const is = new Map(after.map(line => [line.slice(0, line.indexOf('\t')), line]))
  return [...new Set([...was.keys(), ...is.keys()])].filter(path => was.get(path) !== is.get(path)).sort()
}

/** Makes every file under `dir` read-only for everyone. Folders stay as they are: a job adds its own entries (.vite, .vitest-cache) to its linked copy of them. */
const makeReadOnly = dir => {
  for (const [path, stat] of entries(dir)) if (!stat.isSymbolicLink() && stat.mode & 0o222n) chmodSync(join(dir, path), Number(stat.mode & 0o7555n))
}

const hardLinkTree = (from, to) => {
  const done = spawnSync('cp', ['-al', from, to], { encoding: 'utf8' })
  if (done.error) throw done.error
  if (done.status !== 0) throw new Error(`cp -al ${from} ${to} failed: ${(done.stderr || `exit ${done.status}`).trim().split('\n')[0]}`)
}

/**
 * Removes a stored folder so that no job finds it half-removed: it is renamed out of the way first, which is one step.
 * The name it is moved to is this process's alone (mkdtemp picks one that is not there): jobs run in containers of their own that share
 * the store, so two of them can have the same process id.
 */
const removeStored = (root, name) => {
  const away = mkdtempSync(join(root, `.removing-${name}-`))
  renameSync(join(root, name), join(away, name))
  rmSync(away, { recursive: true, force: true })
}

const STATE = 'state.txt'
const MANIFEST = 'manifest.json'

/**
 * Links the checkout's node_modules into the store as `key`, read-only, with the record of its files. The folder is made under another
 * name and renamed into place, so a job never finds a tree that is half there; when another job stored the same key first, that one stays.
 */
const storeTree = ({ root, key, modules, by, now }) => {
  mkdirSync(root, { recursive: true })
  // A folder of this process's own, which no other job can name: a job only ever removes a folder it made itself, or a stale one on a push to the protected branch.
  const making = mkdtempSync(join(root, `.making-${key}-`))
  try {
    hardLinkTree(modules, join(making, 'node_modules'))
    makeReadOnly(join(making, 'node_modules'))
    const { lines, bytes } = treeState(join(making, 'node_modules'))
    writeFileSync(join(making, STATE), lines.join('\n') + '\n')
    writeFileSync(join(making, MANIFEST), JSON.stringify({ key, files: lines.length, bytes, storedAt: new Date(now()).toISOString(), storedBy: by }, null, 2) + '\n')
    // rename does not replace a folder that holds a tree, so when another job stored the same key first this one's fails and is removed.
    if (existsSync(join(root, key))) throw new Error('another job stored it first')
    renameSync(making, join(root, key))
    return { files: lines.length, bytes }
  } catch (error) {
    rmSync(making, { recursive: true, force: true })
    throw error
  }
}

/**
 * Removes every stored tree but `key`, and the folders a killed job left half-made or half-removed once they are stale. Returns the names removed.
 * One that cannot be removed is left for the next push.
 */
export const pruneStore = ({ root, key, now = Date.now }) => {
  const removed = []
  for (const name of readdirSync(root)) {
    if (name === key) continue
    try {
      if (name.startsWith('.')) {
        if (now() - statSync(join(root, name)).mtimeMs < STALE_MS) continue
        rmSync(join(root, name), { recursive: true, force: true })
      } else removeStored(root, name)
      removed.push(name)
    } catch {
      // Left for the next push to the protected branch.
    }
  }
  return removed
}

/** The disk the store uses, in MB, as du counts it (a file linked into several places once); null when du cannot say. */
const diskUse = root => {
  const done = spawnSync('du', ['-sk', root], { encoding: 'utf8' })
  const kb = done.status === 0 ? Number.parseInt(done.stdout, 10) : NaN
  return Number.isFinite(kb) ? Math.round(kb / 1024) : null
}

/** The workerd binaries in a node_modules tree: one per platform package installed (@cloudflare/workerd-linux-64 on the runners). */
export const workerdBinaries = modules => {
  const scope = join(modules, '@cloudflare')
  if (!existsSync(scope)) return []
  return readdirSync(scope)
    .filter(name => name.startsWith('workerd-'))
    .sort()
    .map(name => join(scope, name, 'bin', 'workerd'))
    .filter(path => existsSync(path))
}

/**
 * Reads each file through once, so the host has it in its page cache before a test starts it, and returns how many files and bytes
 * that was. A file that cannot be read is skipped: the test that starts it reads it anyway.
 */
export const warmFiles = paths => {
  const buffer = Buffer.alloc(8 * 1024 * 1024)
  let files = 0
  let bytes = 0
  for (const path of paths) {
    let fd
    try {
      fd = openSync(path, 'r')
      for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) bytes += read
      files += 1
    } catch {
      // Left for the test that starts it.
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  return { files, bytes }
}

/** Reads the workerd binaries under `modules` through and returns { files, bytes, ms }. */
export const warmWorkerd = ({ modules = join(process.cwd(), 'node_modules'), now = Date.now } = {}) => {
  const started = now()
  return { ...warmFiles(workerdBinaries(modules)), ms: now() - started }
}

/** The warm-up's one line: how much it read and how long that took, so a slow disk shows in the log. */
export const warmLine = ({ files, bytes, ms }) => (files === 0 ? 'workerd: no binary to read in node_modules' : `workerd: read ${files} file(s), ${Math.round(bytes / 1024 / 1024)} MB, in ${(ms / 1000).toFixed(1)} s`)

/** The command that installs: the npm on the PATH, or the version the workflow names, through npx (a repository whose tree one npm cannot resolve names another). */
export const npmCommand = env => (env.NODE_INSTALL_NPM_VERSION ? ['npx', ['-y', `npm@${env.NODE_INSTALL_NPM_VERSION}`, 'ci']] : ['npm', ['ci']])

const npmCi = (cwd, env = process.env) => {
  const [command, args] = npmCommand(env)
  // A token for a private registry reaches npm alone, and only when the workflow gave one: an empty one would hide a NODE_AUTH_TOKEN the job set itself.
  const childEnv = env.NODE_INSTALL_AUTH_TOKEN ? { ...env, NODE_AUTH_TOKEN: env.NODE_INSTALL_AUTH_TOKEN } : env
  const done = spawnSync(command, args, { cwd, stdio: 'inherit', env: childEnv })
  if (done.error) throw done.error
  if (done.status !== 0) throw Object.assign(new Error(`npm ci failed (${done.signal ?? `exit ${done.status}`})`), { exitCode: done.status ?? 1 })
}

/**
 * Gives the checkout at `cwd` its node_modules and returns what it did: `how` is linked (from the store), stored (npm ci, then kept for
 * the next job) or installed (npm ci alone, with `why`), `warnings` what went wrong with the store on the way, `changed` the stored files
 * found changed since they were stored (null when no stored tree was looked at), `removed` the stored trees a push to the protected branch removed, and
 * `storeMb` the disk the store uses. `install` runs npm ci and throws when it fails; nothing else here throws.
 */
export const installNodeModules = ({ cwd = process.cwd(), env = process.env, cache = env.NODE_INSTALL_CACHE || CACHE, install = npmCi, link = hardLinkTree, now = Date.now, ...probes } = {}) => {
  const started = now()
  const modules = join(cwd, 'node_modules')
  const { root, why } = storeChoice({ env, cache, ...probes })
  const result = { how: 'installed', why, key: null, files: null, changed: null, removed: [], storeMb: null, warnings: [] }
  const finish = () => ({ ...result, ms: now() - started })
  if (root === null) {
    install(cwd, env)
    // A push to the protected branch installs in full but still removes the trees of other lockfiles (it only deletes), as it did when it used the store.
    if (isMainPush(env) && env.RUNNER_ENVIRONMENT === 'self-hosted') {
      try {
        const stored = join(cache, STORE)
        if (existsSync(stored)) result.removed = pruneStore({ root: stored, key: storeKey({ lockfile: readFileSync(join(cwd, 'package-lock.json')), packageJson: readFileSync(join(cwd, 'package.json'), 'utf8') }), now })
      } catch (error) {
        result.warnings.push(`the store could not be tidied (${error.message})`)
      }
    }
    return finish()
  }

  const key = (result.key = storeKey({ lockfile: readFileSync(join(cwd, 'package-lock.json')), packageJson: readFileSync(join(cwd, 'package.json'), 'utf8') }))
  const entry = join(root, key)
  const by = `run ${env.GITHUB_RUN_ID ?? '?'} (${env.GITHUB_JOB ?? '?'}) on ${env.RUNNER_NAME ?? '?'}`

  if (existsSync(entry)) {
    // A stored tree is used only with its record. One whose record is missing or cannot be read is removed, so this job stores a whole one in its place.
    let manifest, stored
    try {
      manifest = JSON.parse(readFileSync(join(entry, MANIFEST), 'utf8'))
      stored = readFileSync(join(entry, STATE), 'utf8').split('\n').filter(Boolean)
    } catch (error) {
      result.warnings.push(`the stored tree has no record that can be read (${error.message}), so it is removed and installed afresh`)
    }
    try {
      if (stored === undefined) removeStored(root, key)
      else if ((result.changed = stateDifference(stored, treeState(join(entry, 'node_modules')).lines)).length > 0) {
        const last = existsSync(join(entry, 'last-used')) ? readFileSync(join(entry, 'last-used'), 'utf8').trim() : 'no job'
        result.warnings.push(`${result.changed.length} stored file(s) changed since ${manifest.storedBy} stored them (last used by ${last}): ${result.changed.slice(0, 10).join(', ')}${result.changed.length > 10 ? ', …' : ''}. The stored tree is removed and installed afresh.`)
        removeStored(root, key)
      } else {
        rmSync(modules, { recursive: true, force: true })
        link(join(entry, 'node_modules'), modules)
        writeFileSync(join(entry, 'last-used'), `${by} at ${new Date(now()).toISOString()}\n`)
        result.how = 'linked'
        result.files = stored.length
      }
    } catch (error) {
      result.warnings.push(`the stored tree could not be used (${error.message}), so npm ci runs instead`)
    }
  }

  if (result.how !== 'linked') {
    // A tree that was half linked goes first: npm ci must write new files, never into one that is also the stored file.
    rmSync(modules, { recursive: true, force: true })
    install(cwd, env)
    result.why = result.warnings.length > 0 ? 'the stored tree could not be used' : 'no tree is stored for this lockfile and Node version'
    if (!existsSync(entry)) {
      try {
        result.files = storeTree({ root, key, modules, by, now }).files
        result.how = 'stored'
      } catch (error) {
        result.warnings.push(`the installed tree could not be stored (${error.message})`)
      }
    }
  }

  try {
    if (isMainPush(env)) result.removed = pruneStore({ root, key, now })
    result.storeMb = diskUse(root)
  } catch (error) {
    result.warnings.push(`the store could not be tidied (${error.message})`)
  }
  return finish()
}

/** The run's one line: what was done, how long it took, where, and what the store holds. */
export const summary = (result, { env = process.env, host = hostname() } = {}) => {
  const seconds = (result.ms / 1000).toFixed(1)
  const did = { linked: `linked ${result.files} stored files`, stored: `ran npm ci and stored ${result.files} files`, installed: `ran npm ci (${result.why})` }[result.how]
  const parts = [`node_modules: ${did} in ${seconds} s`, `runner ${env.RUNNER_NAME ?? 'unknown'} on ${host}`]
  if (result.key !== null) parts.push(`key ${result.key}`)
  if (result.changed !== null) parts.push(result.changed.length === 0 ? 'stored files unchanged' : `${result.changed.length} stored file(s) had changed`)
  if (result.removed.length > 0) parts.push(`removed ${result.removed.length} old tree(s)`)
  if (result.storeMb !== null) parts.push(`the store uses ${result.storeMb} MB`)
  return parts.join('; ')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--warm-workerd') {
      console.log(warmLine(warmWorkerd()))
      process.exit(0)
    }
    const result = installNodeModules()
    // A warning shows on the run's page; the line is also in the job's summary, so the figures can be read without opening a log.
    for (const warning of result.warnings) console.log(`::warning title=node_modules store::${warning.replace(/\r?\n/g, ' ')}`)
    const line = summary(result)
    console.log(line)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
  } catch (error) {
    console.error(error.message)
    process.exit(error.exitCode ?? 1)
  }
}
