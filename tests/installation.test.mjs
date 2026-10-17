import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createDownloadPackage } from '../lib/download-package.js'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const installer = join(root, 'scripts', 'install-plugin.ps1')
const packager = join(root, 'scripts', 'Package-DshTavernImage.ps1')
const powershell = process.env.POWERSHELL_EXE || 'powershell.exe'
const officialCli = process.env.DSH_CLI_PATH || join(
  process.env.LOCALAPPDATA || '',
  'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
)
const testWithTimeout = (name, fn) => test(name, { timeout: 120_000 }, fn)
const projectVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const projectVersionPattern = new RegExp(projectVersion.replace(/\./g, '\\.'))

async function runPowerShell(args, options = {}) {
  try {
    return await execFileAsync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], {
      windowsHide: true,
      timeout: 90_000,
      ...options,
    })
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`PowerShell is required for installation tests: ${error.message}`)
    throw error
  }
}

async function makeSandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tavern-image-install-test-'))
  t.after(async () => {
    const cleanupPath = resolve(directory)
    const tempRoot = resolve(tmpdir()).replace(/[\\/]+$/, '') + sep
    if (!cleanupPath.toLowerCase().startsWith(tempRoot.toLowerCase()) || !basename(cleanupPath).startsWith('dsh-tavern-image-install-test-')) {
      throw new Error('拒绝清理测试临时目录之外的路径')
    }
    await rm(cleanupPath, { recursive: true, force: true })
  })
  const dshHome = join(directory, 'dsh-home')
  const profile = join(dshHome, 'profiles', 'sim')
  const config = join(directory, 'package-manager-config')
  const store = join(directory, 'pnpm-store')
  await mkdir(profile, { recursive: true })
  await mkdir(config, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-sim',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(config, 'user.npmrc'), `registry=http://127.0.0.1:9/\nstore-dir=${store.replaceAll('\\', '/')}\n`)
  await writeFile(join(config, 'global.npmrc'), `registry=http://127.0.0.1:9/\nstore-dir=${store.replaceAll('\\', '/')}\n`)
  return {
    directory,
    dshHome,
    profile,
    sourceTarget: join(dshHome, 'profile-data', 'sim', 'data', 'tools', 'dsh-tavern-image'),
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      LOCALAPPDATA: join(directory, 'local-app-data'),
      PNPM_HOME: join(directory, 'pnpm-home'),
      COREPACK_HOME: join(directory, 'corepack-home'),
      XDG_CACHE_HOME: join(directory, 'cache'),
      npm_config_userconfig: join(config, 'user.npmrc'),
      npm_config_globalconfig: join(config, 'global.npmrc'),
      npm_config_registry: 'http://127.0.0.1:9/',
      npm_config_store_dir: store,
      pnpm_config_store_dir: store,
    },
  }
}

async function installArgs(sandbox, sourceArgs) {
  return [
    installer,
    '-Profile', 'sim',
    '-DshHome', sandbox.dshHome,
    '-DshCliPath', officialCli,
    ...sourceArgs,
  ]
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(files) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, contents] of files) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(contents)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

const minimalManifest = JSON.stringify({
  name: 'dsh-tavern-comfy',
  version: '2.5.1',
  main: 'lib/index.js',
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
})

testWithTimeout('installer recognizes nested ZIPs, copies only package files, and registers link + bundle through official DSH CLI', async t => {
  if (process.platform !== 'win32') return t.skip('PowerShell installation tests run on Windows')
  if (!(await stat(officialCli).catch(() => null))) return t.skip('Official DSH Desktop CLI is not installed on this host')

  const sandbox = await makeSandbox(t)
  const packageArchive = join(sandbox.directory, 'nested-source.zip')
  const patch = '- insert:\n    - id: dsh-tavern-image\n      name: dsh-tavern-comfy\n'
  const files = [
    ['one/two/dsh-tavern-image-master/package.json', minimalManifest],
    ['one/two/dsh-tavern-image-master/lib/index.js', 'export function apply() {}\n'],
    ['one/two/dsh-tavern-image-master/client.js', 'export default {}\n'],
    ['one/two/dsh-tavern-image-master/cordis.patch.yml', patch],
    ['one/two/dsh-tavern-image-master/README.md', '# package\n'],
    ['one/two/dsh-tavern-image-master/config.json', '{"private":true}'],
    ['one/two/dsh-tavern-image-master/worldbook.json', '{"private":true}'],
    ['one/two/dsh-tavern-image-master/workflows/user.json', '{"private":true}'],
    ['one/two/dsh-tavern-image-master/tests/secret.test.mjs', 'private fixture'],
  ]
  await writeFile(packageArchive, makeZip(files))
  const result = await runPowerShell(await installArgs(sandbox, ['-SourceArchive', packageArchive]), { env: sandbox.env })
  assert.match(result.stdout, /dsh-tavern-comfy/)
  assert.match(result.stdout, /Done in/)

  const installed = JSON.parse(await readFile(join(sandbox.sourceTarget, 'package.json'), 'utf8'))
  assert.equal(installed.name, 'dsh-tavern-comfy')
  assert.equal(await readFile(join(sandbox.sourceTarget, 'lib', 'index.js'), 'utf8'), 'export function apply() {}\n')
  for (const privateFile of ['config.json', 'worldbook.json', 'workflows/user.json', 'tests/secret.test.mjs']) {
    await assert.rejects(stat(join(sandbox.sourceTarget, privateFile)))
  }

  const profile = JSON.parse(await readFile(join(sandbox.profile, 'package.json'), 'utf8'))
  assert.match(profile.dependencies['dsh-tavern-comfy'], /link:/)
  assert.ok(profile.dsh.profile.bundles.includes('dsh-tavern-comfy'))
  const pluginLink = join(sandbox.profile, 'node_modules', 'dsh-tavern-comfy')
  assert.ok((await lstat(pluginLink)).isSymbolicLink())
  assert.equal(await realpath(pluginLink), await realpath(sandbox.sourceTarget))
  assert.match(result.stdout, /--ignore-scripts|ignore-scripts|Done in/)
})

testWithTimeout('installer rejects ZIP-slip paths before creating the plugin target', async t => {
  if (process.platform !== 'win32') return t.skip('PowerShell installation tests run on Windows')
  if (!(await stat(officialCli).catch(() => null))) return t.skip('Official DSH Desktop CLI is not installed on this host')

  const sandbox = await makeSandbox(t)
  const malicious = join(sandbox.directory, 'unsafe.zip')
  const patch = '- insert:\n    - id: dsh-tavern-image\n      name: dsh-tavern-comfy\n'
  await writeFile(malicious, makeZip([
    ['repo/package.json', minimalManifest],
    ['repo/lib/index.js', 'export function apply() {}'],
    ['repo/client.js', 'export default {}'],
    ['repo/cordis.patch.yml', patch],
    ['repo/../outside.txt', 'must not be written'],
  ]))

  await assert.rejects(runPowerShell(await installArgs(sandbox, ['-SourceArchive', malicious]), { env: sandbox.env }))
  await assert.rejects(stat(sandbox.sourceTarget))
  await assert.rejects(stat(join(sandbox.directory, 'outside.txt')))
})

testWithTimeout('installer leaves an existing plugin directory and profile untouched', async t => {
  if (process.platform !== 'win32') return t.skip('PowerShell installation tests run on Windows')
  if (!(await stat(officialCli).catch(() => null))) return t.skip('Official DSH Desktop CLI is not installed on this host')

  const sandbox = await makeSandbox(t)
  await mkdir(sandbox.sourceTarget, { recursive: true })
  const privatePath = join(sandbox.sourceTarget, 'config.json')
  await writeFile(privatePath, '{"keep":"private"}')
  const beforeProfile = await readFile(join(sandbox.profile, 'package.json'), 'utf8')
  await assert.rejects(runPowerShell(await installArgs(sandbox, ['-SourceDirectory', root]), { env: sandbox.env }))
  assert.equal(await readFile(privatePath, 'utf8'), '{"keep":"private"}')
  assert.equal(await readFile(join(sandbox.profile, 'package.json'), 'utf8'), beforeProfile)
})

testWithTimeout('portable root/profile paths work with NoRegister without changing another profile or its stage directory', async t => {
  if (process.platform !== 'win32') return t.skip('PowerShell installation tests run on Windows')

  const sandbox = await makeSandbox(t)
  const otherProfile = join(sandbox.dshHome, 'profiles', 'other')
  const targetTools = join(sandbox.dshHome, 'profile-data', 'sim', 'data', 'tools')
  const unrelatedStage = join(targetTools, '.dsh-tavern-image-stage-in-progress')
  await mkdir(otherProfile, { recursive: true })
  await mkdir(unrelatedStage, { recursive: true })
  const otherManifest = JSON.stringify({ name: 'dsh-profile-other', dependencies: { keep: '1.0.0' } })
  await writeFile(join(otherProfile, 'package.json'), otherManifest)
  await writeFile(join(unrelatedStage, 'owner.txt'), 'another operation')

  const args = [
    installer, '-Profile', 'sim', '-Root', join(sandbox.dshHome, 'profiles'),
    '-SourceDirectory', root, '-NoRegister', '-Quiet',
  ]
  await assert.rejects(runPowerShell(args, { env: sandbox.env }))
  assert.equal(await readFile(join(unrelatedStage, 'owner.txt'), 'utf8'), 'another operation')
  await rm(unrelatedStage, { recursive: true })

  const result = await runPowerShell(args, { env: sandbox.env })
  assert.equal(result.stdout, '')
  assert.equal(JSON.parse(await readFile(join(otherProfile, 'package.json'), 'utf8')).dependencies.keep, '1.0.0')
  assert.equal(JSON.parse(await readFile(join(sandbox.sourceTarget, 'package.json'), 'utf8')).version, projectVersion)
  assert.equal(await stat(join(sandbox.profile, 'node_modules')).catch(() => null), null)

  const profileRootSandbox = await makeSandbox(t)
  await runPowerShell([
    installer, '-Profile', 'sim', '-DshHome', join(profileRootSandbox.profile),
    '-SourceDirectory', root, '-NoRegister', '-Quiet',
  ], { env: profileRootSandbox.env })
  assert.equal(JSON.parse(await readFile(join(profileRootSandbox.sourceTarget, 'package.json'), 'utf8')).version, projectVersion)
})

testWithTimeout('automatic discovery skips roots without the target profile and normalizes DSH_HOME profiles paths', async t => {
  if (process.platform !== 'win32') return t.skip('PowerShell installation tests run on Windows')

  const sandbox = await makeSandbox(t)
  const wrongRoot = join(sandbox.directory, 'wrong-dsh')
  const rightRoot = join(sandbox.directory, 'portable-dsh')
  await mkdir(join(wrongRoot, 'profiles', 'other'), { recursive: true })
  await mkdir(join(rightRoot, 'profiles', 'sim'), { recursive: true })
  await writeFile(join(rightRoot, 'profiles', 'sim', 'package.json'), JSON.stringify({ name: 'portable-sim', dependencies: {} }))
  const env = {
    ...sandbox.env,
    DSH_HOME: join(wrongRoot, 'profiles'),
    USERPROFILE: sandbox.directory,
    LOCALAPPDATA: join(sandbox.directory, 'local-app-data'),
    APPDATA: join(sandbox.directory, 'app-data'),
  }

  await assert.rejects(runPowerShell([
    installer, '-Profile', 'sim', '-DshHome', wrongRoot,
    '-SourceDirectory', root, '-NoRegister', '-Quiet',
  ], { env }))
  await assert.rejects(stat(join(wrongRoot, 'profile-data')))

  await mkdir(join(sandbox.directory, '.dsh', 'profiles', 'sim'), { recursive: true })
  await writeFile(join(sandbox.directory, '.dsh', 'profiles', 'sim', 'package.json'), JSON.stringify({ name: 'fallback-sim', dependencies: {} }))
  const fallbackRoot = join(sandbox.directory, '.dsh')
  const fallbackEnv = { ...env, DSH_HOME: join(wrongRoot, 'profiles') }
  await runPowerShell([
    installer, '-Profile', 'sim', '-SourceDirectory', root, '-NoRegister', '-Quiet',
  ], { env: fallbackEnv })
  assert.equal(JSON.parse(await readFile(join(fallbackRoot, 'profile-data', 'sim', 'data', 'tools', 'dsh-tavern-image', 'package.json'), 'utf8')).version, projectVersion)

  const profilesEnv = { ...env, DSH_HOME: join(rightRoot, 'profiles') }
  await runPowerShell([
    installer, '-Profile', 'sim', '-SourceDirectory', root, '-NoRegister', '-Quiet',
  ], { env: profilesEnv })
  assert.equal(JSON.parse(await readFile(join(rightRoot, 'profile-data', 'sim', 'data', 'tools', 'dsh-tavern-image', 'package.json'), 'utf8')).version, projectVersion)
})

testWithTimeout('local install bundle contains a source ZIP with only the declared package files', async t => {
  if (process.platform !== 'win32') return t.skip('PowerShell packaging tests run on Windows')
  const sandbox = await makeSandbox(t)
  const bundle = join(sandbox.directory, 'install-bundle.zip')
  await runPowerShell([packager, '-OutputPath', bundle], { env: sandbox.env })
  const extracted = join(sandbox.directory, 'bundle')
  const expandScript = join(sandbox.directory, 'expand.ps1')
  await writeFile(expandScript, 'param([string]$ArchivePath,[string]$DestinationPath)\nExpand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath\n')
  await runPowerShell([expandScript, '-ArchivePath', bundle, '-DestinationPath', extracted], { env: sandbox.env })
  assert.ok(await stat(join(extracted, 'install-plugin.ps1')))
  assert.ok(await stat(join(extracted, 'Install-DshTavernImage.cmd')))
  assert.ok(await stat(join(extracted, 'dsh-tavern-image-source.zip')))
  const nestedRoot = join(sandbox.directory, 'nested-source')
  await runPowerShell([expandScript, '-ArchivePath', join(extracted, 'dsh-tavern-image-source.zip'), '-DestinationPath', nestedRoot], { env: sandbox.env })
  assert.ok(await stat(join(nestedRoot, 'dsh-tavern-image', 'scripts', 'Package-DshTavernImage.ps1')), 'source ZIP preserves the packager')

  const sourceZip = join(extracted, 'dsh-tavern-image-source.zip')
  const installSandbox = await makeSandbox(t)
  const result = await runPowerShell(await installArgs(installSandbox, ['-SourceArchive', sourceZip]), { env: installSandbox.env })
  assert.match(result.stdout, projectVersionPattern)
  const installedEntries = await readdir(installSandbox.sourceTarget)
  assert.ok(installedEntries.includes('client.js'))
  assert.ok(installedEntries.includes('lib'))
  for (const excluded of ['tests', 'config.json', 'definitions.json', 'worldbook.json', 'cache', 'jobs-store.json']) {
    assert.ok(!installedEntries.includes(excluded), `package output must exclude ${excluded}`)
  }
  assert.ok(await stat(join(installSandbox.sourceTarget, 'workflows', '.gitkeep')))
  assert.ok(await stat(join(installSandbox.sourceTarget, 'scripts', 'install-plugin.ps1')), 'installed source keeps the installer for later local downloads')
  assert.ok(await stat(join(installSandbox.sourceTarget, 'scripts', 'Install-DshTavernImage.cmd')))
  assert.ok(await stat(join(installSandbox.sourceTarget, 'scripts', 'Package-DshTavernImage.ps1')), 'installed source keeps the packager for re-export')
  const repacked = join(sandbox.directory, 'repacked-from-installed-source.zip')
  await runPowerShell([join(installSandbox.sourceTarget, 'scripts', 'Package-DshTavernImage.ps1'), '-OutputPath', repacked], { env: installSandbox.env })
  assert.ok(await stat(repacked), 'installed source can create another offline installer bundle')
})

testWithTimeout('server download ZIP buffer installs through the official DSH CLI in an isolated profile', async t => {
  if (process.platform !== 'win32') return t.skip('PowerShell installation tests run on Windows')
  if (!(await stat(officialCli).catch(() => null))) return t.skip('Official DSH Desktop CLI is not installed on this host')

  const sandbox = await makeSandbox(t)
  const archivePath = join(sandbox.directory, 'server-download.zip')
  const archive = await createDownloadPackage(root)
  await writeFile(archivePath, archive)

  const result = await runPowerShell(await installArgs(sandbox, ['-SourceArchive', archivePath]), { env: sandbox.env })
  assert.match(result.stdout, projectVersionPattern)
  assert.match(result.stdout, /SHA-256/)
  assert.match(result.stdout, /Done in/)
  const profile = JSON.parse(await readFile(join(sandbox.profile, 'package.json'), 'utf8'))
  assert.match(profile.dependencies['dsh-tavern-comfy'], /^link:/)
  assert.ok(profile.dsh.profile.bundles.includes('dsh-tavern-comfy'))
  assert.equal(JSON.parse(await readFile(join(sandbox.sourceTarget, 'package.json'), 'utf8')).name, 'dsh-tavern-comfy')
  await assert.rejects(stat(join(sandbox.sourceTarget, 'config.json')))
})
