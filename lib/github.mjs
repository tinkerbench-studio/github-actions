/**
 * Reads GitHub's REST API with the workflow's own token. Reading only: no action here writes to GitHub through this.
 */

/**
 * A function that GETs a path of the API (`/repos/o/r/...`) and returns the parsed answer. It throws when GitHub does not answer 2xx,
 * naming the path and the status, so a caller that cannot tell says why.
 */
export const reader = ({ api = 'https://api.github.com', token, get = fetch, timeoutMs = 20_000 }) => {
  if (!token) throw new Error('no token to read GitHub with')
  return async path => {
    const response = await get(`${api}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`)
    return response.json()
  }
}
