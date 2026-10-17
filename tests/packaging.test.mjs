import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const sourceManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packager = join(root, 'scripts', 'Package-DshTavernImage.ps1')
const powershell = process.env.POWERSHELL_EXE || 'powershell.exe'

async function runPowerShell(args) {
  return execFileAsync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    windowsHide: true,
    timeout: 90_000,
  })
}

test('published offline packager creates a clean installer bundle matching the source version', async t => {
  if (process.platform !== 'win32') return t.skip('PowerShell packaging tests run on Windows')

  const directory = await mkdtemp(join(tmpdir(), 'dsh-tavern-image-package-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'install-bundle.zip')
  const extracted = join(directory, 'bundle')
  const source = join(directory, 'source')
  const sourceExtracted = join(directory, 'source-files')
  const expandScript = join(directory, 'expand.ps1')
  await writeFile(expandScript, [
    'param([string]$ArchivePath,[string]$DestinationPath)',
    'Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force',
  ].join('\n'))

  await runPowerShell(['-File', packager, '-OutputPath', output])
  await runPowerShell(['-File', expandScript, '-ArchivePath', output, '-DestinationPath', extracted])
  for (const file of ['install-plugin.ps1', 'Install-DshTavernImage.cmd', 'dsh-tavern-image-source.zip']) {
    assert.ok(await stat(join(extracted, file)))
  }
  await runPowerShell(['-File', expandScript, '-ArchivePath', join(extracted, 'dsh-tavern-image-source.zip'), '-DestinationPath', sourceExtracted])

  const packageRoot = join(sourceExtracted, 'dsh-tavern-image')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.version, sourceManifest.version)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(await stat(join(packageRoot, 'scripts', 'install-plugin.ps1')))
  assert.ok(await stat(join(packageRoot, 'scripts', 'Install-DshTavernImage.cmd')))
  assert.ok(await stat(join(packageRoot, 'scripts', 'Package-DshTavernImage.ps1')))
  const entries = await readdir(packageRoot)
  for (const privateFile of ['config.json', 'definitions.json', 'worldbook.json', 'tests', 'node_modules']) {
    assert.ok(!entries.includes(privateFile), `source archive must exclude ${privateFile}`)
  }
})
