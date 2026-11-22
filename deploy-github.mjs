import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'

// Uses the existing Git credential manager. Credentials stay in process memory.
const credential = execFileSync('git', ['-c', 'credential.interactive=never', 'credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
  stdio: ['pipe', 'pipe', 'pipe']
})
const password = credential.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9)
if (!password) throw Error('No existing GitHub credential available')
const headers = {
  Authorization: `Bearer ${password}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json'
}
async function api(path, method = 'GET', body, allowMissing = false) {
  const response = await fetch('https://api.github.com' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  })
  if (allowMissing && response.status === 404) return null
  const result = response.status === 204 ? {} : await response.json()
  if (!response.ok) {
    const error = Error(`${method} ${path} failed (${response.status}): ${result.message}`)
    error.status = response.status
    throw error
  }
  return result
}

const user = await api('/user')
if (user.login !== 'byl11111') throw Error('Git credential account differs from connected account')
const repository = user.login + '/urban-textures'
const base = '/repos/' + repository
let repo = await api(base, 'GET', undefined, true)
if (!repo) {
  repo = await api('/user/repos', 'POST', {
    name: 'urban-textures', description: 'Urban Textures / 城市感官转译实验室',
    private: false, auto_init: true
  })
  console.log('Created repository', repo.html_url)
} else {
  if (repo.description !== 'Urban Textures / 城市感官转译实验室') throw Error('Repository already exists with a different description')
  if (repo.private) throw Error('Existing repository is private. Visibility was preserved.')
}

let pagesCommit
if (!process.argv.includes('--status')) {
const root = new URL('.', import.meta.url)
const file = path => new URL(path, root)
const paths = ['index.html', 'package.json', 'build.mjs', 'README.md', '启动城市感官转译实验室.cmd', 'deploy-github.mjs']
for (const directory of ['src', 'tests', 'dist']) {
  for (const entry of await readdir(file(directory), { withFileTypes: true })) {
    if (entry.isFile()) paths.push(directory + '/' + entry.name)
  }
}
const mainHead = await api(base + '/git/ref/heads/' + repo.default_branch)
const mainCommit = await api(base + '/git/commits/' + mainHead.object.sha)
const blobs = []
// Upload only this project's explicit source and built files.
for (const path of paths) {
  const content = await readFile(file(path), 'utf8')
  const blob = await api(base + '/git/blobs', 'POST', { content, encoding: 'utf-8' })
  blobs.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
}
const tree = await api(base + '/git/trees', 'POST', { base_tree: mainCommit.tree.sha, tree: blobs })
const commit = await api(base + '/git/commits', 'POST', {
  message: 'Publish Urban Textures classroom application', tree: tree.sha, parents: [mainHead.object.sha]
})
await api(base + '/git/refs/heads/' + repo.default_branch, 'PATCH', { sha: commit.sha, force: false })
console.log('Published project source', commit.sha)

const pagesHead = await api(base + '/git/ref/heads/gh-pages', 'GET', undefined, true)
const website = blobs.find(blob => blob.path === 'dist/index.html')
const nojekyll = await api(base + '/git/blobs', 'POST', { content: '', encoding: 'utf-8' })
const pagesTree = await api(base + '/git/trees', 'POST', { tree: [
  { ...website, path: 'index.html' },
  { path: '.nojekyll', mode: '100644', type: 'blob', sha: nojekyll.sha }
] })
pagesCommit = await api(base + '/git/commits', 'POST', {
  message: 'Deploy static classroom site', tree: pagesTree.sha,
  parents: [pagesHead?.object.sha ?? commit.sha]
})
if (pagesHead) await api(base + '/git/refs/heads/gh-pages', 'PATCH', { sha: pagesCommit.sha, force: false })
else await api(base + '/git/refs', 'POST', { ref: 'refs/heads/gh-pages', sha: pagesCommit.sha })
} else {
  const head = await api(base + '/git/ref/heads/gh-pages')
  pagesCommit = { sha: head.object.sha }
}

let pages = await api(base + '/pages', 'GET', undefined, true)
if (!pages) {
  try {
    pages = await api(base + '/pages', 'POST', { source: { branch: 'gh-pages', path: '/' }, build_type: 'legacy' })
  } catch (error) {
    if (error.status !== 409) throw error
    for (let i = 0; i < 6 && !pages; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000))
      pages = await api(base + '/pages', 'GET', undefined, true)
    }
    if (!pages) throw Error('Pages is enabled but its status is temporarily unavailable')
  }
}
else if (pages.source?.branch !== 'gh-pages') throw Error('Existing Pages source differs from gh-pages')
console.log(JSON.stringify({ repository: repo.html_url, url: pages.html_url, status: pages.status, deployCommit: pagesCommit.sha }))

for (let i = 0; i < 36; i++) {
  const build = await api(base + '/pages/builds/latest', 'GET', undefined, true)
  if (build?.status === 'errored') throw Error('Pages build failed: ' + build.error?.message)
  if (build?.status === 'built' && build.commit === pagesCommit.sha) {
    const response = await fetch(pages.html_url, { cache: 'no-store' })
    const content = await response.text()
    if (response.ok && content.includes('voxelMin') && content.includes('form-options')) {
      console.log('LIVE', pages.html_url, 'HTTP', response.status)
      process.exit(0)
    }
  }
  await new Promise(resolve => setTimeout(resolve, 10000))
}
throw Error('Pages publication did not finish within six minutes')

