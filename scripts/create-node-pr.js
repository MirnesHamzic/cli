const { join } = require('path')
const hgi = require('hosted-git-info')
const pacote = require('pacote')
const log = require('proc-log')
const tar = require('tar')
const { cp, withTempDir, access, constants } = require('@npmcli/fs')
const { CWD, run, spawn, git, fs, gh } = require('./util.js')

// this script expects node to already be cloned to a directory at the cli root named "node"
const NODE_DIR = join(CWD, 'node')
const gitNode = spawn.create('git', { cwd: NODE_DIR })

const createNodeTarball = async ({ mani, registryOnly, tag, dir: extractDir }) => {
  const tarball = join(extractDir, 'npm-node.tgz')
  await pacote.tarball.file(mani._from, tarball, { resolved: mani._resolved })

  if (registryOnly) {
    // a future goal is to only need files from the published tarball for
    // inclusion in node. in that case, we'd be able to remove everything after
    // this line since we have already fetched the tarball
    return tarball
  }

  // extract tarball to current dir and delete original tarball
  await tar.x({ strip: 1, file: tarball, cwd: extractDir })
  await fs.rimraf(tarball)

  // checkout the tag since we need to get files from source.
  await git.dirty()
  tag && await git('checkout', tag)
  for (const path of ['.npmrc', 'tap-snapshots/', 'test/']) {
    await cp(join(CWD, path), join(extractDir, path), { recursive: true })
  }

  await tar.c({
    ...pacote.DirFetcher.tarCreateOptions(mani),
    cwd: extractDir,
    file: tarball,
  }, ['.'])

  return tarball
}

const main = async (spec, branch = 'main', opts) => withTempDir(CWD, async (tmpDir) => {
  const { GITHUB_TOKEN } = process.env
  const { dryRun, registryOnly } = opts

  if (!spec) {
    throw new Error('`spec` is required as the first argument')
  }

  if (!branch) {
    throw new Error('`branch` is required as the second argument')
  }

  if (!GITHUB_TOKEN) {
    throw new Error(`process.env.GITHUB_TOKEN is required`)
  }

  const mani = await pacote.manifest(`npm@${spec}`, { preferOnline: true })

  const headHost = hgi.fromUrl('npm/node')
  const headRemoteUrl = new URL(headHost.https())
  headRemoteUrl.username = GITHUB_TOKEN
  const head = {
    tag: `v${mani.version}`,
    branch: `npm-v${mani.version}`,
    host: headHost,
    remoteUrl: headRemoteUrl.toString(),
    message: `deps: upgrade npm to ${mani.version}`,
  }
  log.silly(head)

  const tarball = await createNodeTarball({
    mani,
    dir: tmpDir,
    registryOnly,
    tag: head.tag,
  })

  await access(NODE_DIR, constants.F_OK).catch(() => {
    throw new Error(`node repo must be checked out to \`${NODE_DIR}\` to continue`)
  })

  const base = {
    remote: 'origin',
    branch: /^\d+$/.test(branch) ? `v${branch}.x-staging` : branch,
    host: hgi.fromUrl(await gitNode('remote', 'get-url', 'origin', { out: true })),
  }
  log.silly(base)

  await gh('repo', 'fork', base.host.path(), '--org', head.host.user, { quiet: true, ok: true })
  await gitNode('fetch', base.remote)
  await gitNode('checkout', base.branch)
  await gitNode('reset', '--hard', `${base.remote}/${base.branch}`)
  await gitNode('branch', '-D', head.branch, { ok: true })
  await gitNode('checkout', '-b', head.branch)

  const npmPath = join('deps', 'npm')
  const npmDir = join(NODE_DIR, npmPath)
  await fs.clean(npmDir)
  await tar.x({ strip: 1, file: tarball, cwd: npmDir })

  await gitNode('add', '-A', npmPath)
  await gitNode('commit', '-m', head.message)
  await gitNode('rebase', '--whitespace', 'fix', base.branch)

  await gitNode('remote', 'rm', head.host.user, { ok: true })
  await gitNode('remote', 'add', head.host.user, head.remoteUrl, { ok: true })
  await gitNode('push', head.host.user, head.branch, '--force-with-lease')

  const notes = await gh.json('release', 'view', head.tag, 'body')
  log.silly('body', notes)

  const prArgs = [
    'pr', 'create',
    '-R', base.host.path(),
    '-B', base.branch,
    '-H', `${head.host.user}:${head.branch}`,
    '-t', head.message,
  ]

  if (dryRun) {
    log.info(`gh ${prArgs.join(' ')}`)
    const compare = `${base.branch}...${head.host.user}:${head.host.project}:${head.branch}`
    const url = new URL(base.host.browse())
    url.pathname += `/compare/${compare}`
    url.searchParams.set('expand', '1')
    return url.toString()
  }

  return gh(...prArgs, '-F', '-', { cwd: NODE_DIR, input: notes, out: true })
})

run(({ argv, ...opts }) => main(argv.remain[0], argv.remain[1], opts))
