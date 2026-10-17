import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDownloadPackage } from '../lib/download-package.js'

const testWithTimeout = (name, fn) => test(name, { timeout: 120_000 }, fn)

function contents(zip) {
  const entries = new Map()
  let position = 0
  while (zip.readUInt32LE(position) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(position + 8), 0)
    const size = zip.readUInt32LE(position + 18)
    const nameLength = zip.readUInt16LE(position + 26)
    const extraLength = zip.readUInt16LE(position + 28)
    const start = position + 30 + nameLength + extraLength
    entries.set(zip.toString('utf8', position + 30, position + 30 + nameLength), zip.subarray(start, start + size))
    position = start + size
  }
  assert.equal(zip.readUInt32LE(position), 0x02014b50)
  return entries
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-package-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const directory of ['lib', 'scripts', 'workflows', '.git', 'node_modules', 'cache']) await mkdir(join(root, directory))
  for (const [name, data] of Object.entries({
    'package.json': '{"name":"dsh-tavern-comfy","version":"2.1.0"}',
    'client.js': 'export default {}', 'cordis.patch.yml': '[]', 'lib/index.js': 'export default {}',
    'scripts/install-plugin.ps1': '# installer', 'scripts/Install-DshTavernImage.cmd': '@echo off', 'scripts/Package-DshTavernImage.ps1': '# packager',
    'workflows/.gitkeep': '', 'config.json': 'SECRET_API_KEY', 'definitions.json': 'PRIVATE_CHARACTERS',
    'worldbook.json': 'PRIVATE_WORLDBOOK', 'jobs.json': 'PRIVATE_JOBS', 'workflows/custom.json': 'PRIVATE_WORKFLOW',
    'cache/output.png': 'PRIVATE_IMAGE', '.git/config': 'PRIVATE_REMOTE', 'node_modules/private.js': 'DEPENDENCY'
  })) await writeFile(join(root, name), data)
  return root
}

testWithTimeout('download ZIP includes installable code and installer, excludes local user data', async t => {
  const root = await fixture(t)
  const first = await createDownloadPackage(root)
  assert.deepEqual(await createDownloadPackage(root), first)
  const files = contents(first)
  for (const name of ['lib/index.js', 'client.js', 'package.json', 'scripts/install-plugin.ps1', 'scripts/Install-DshTavernImage.cmd', 'scripts/Package-DshTavernImage.ps1']) {
    assert.ok(files.has('dsh-tavern-image/' + name), name)
  }
  assert.equal(files.size, 8)
  assert.ok(!first.toString().includes('PRIVATE_'))
  assert.ok(!first.toString().includes('SECRET_API_KEY'))
})

testWithTimeout('incomplete source fails rather than exporting a broken package', async t => {
  const root = await fixture(t)
  await rm(join(root, 'lib/index.js'))
  await assert.rejects(createDownloadPackage(root), /缺少插件入口/)
})
