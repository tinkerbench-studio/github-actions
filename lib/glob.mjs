/**
 * The one glob dialect of these actions, which is the one Tick-it's merge rules use (tick-it, apps/mcp/src/areas.ts), so a path list
 * means the same in a workflow, in `.tick-it` config and here:
 *
 * - `*` is any run of characters but `/`
 * - `**` is any run including `/`; `**` followed by `/` also matches no directory
 * - `?` is one character but `/`
 * - a glob matches at any depth unless it starts with `/`: `*.md` is markdown anywhere, `/docs/**` only the top-level docs folder
 */
export const matchesGlob = (path, glob) => {
  const anchored = glob.startsWith('/')
  const body = anchored ? glob.slice(1) : glob
  let source = ''
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i)
    if (c === '*') {
      if (body[i + 1] === '*') {
        i++
        if (body[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else source += '.*'
      } else source += '[^/]*'
    } else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}$`).test(path)
}

/** Whether any of `globs` matches `path`. */
export const matchesAny = (path, globs) => globs.some(glob => matchesGlob(path, glob))
