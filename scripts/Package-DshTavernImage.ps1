[CmdletBinding()]
param([string] $OutputPath)

$ErrorActionPreference = 'Stop'
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$SourceFiles = @(
  'package.json', 'client.js', 'cordis.patch.yml', 'console.html', 'design-rules.md',
  'LICENSE', 'README.md', '世界书-通用生图规则.json', 'workflows/.gitkeep',
  'scripts/install-plugin.ps1', 'scripts/Install-DshTavernImage.cmd', 'scripts/Package-DshTavernImage.ps1'
)

if (-not $OutputPath) { $OutputPath = Join-Path $RepositoryRoot 'dsh-tavern-image-install.zip' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$OutputDirectory = Split-Path -Parent $OutputPath
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-tavern-image-package-' + [guid]::NewGuid().ToString('N'))
$BundleRoot = Join-Path $TempRoot 'bundle'
$SourceZip = Join-Path $BundleRoot 'dsh-tavern-image-source.zip'

function Add-SourceTreeToZip([IO.Compression.ZipArchive] $Archive, [string] $Root, [string] $RelativePath) {
  $fullPath = Join-Path $Root ($RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar))
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { return }
  $item = Get-Item -LiteralPath $fullPath -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "插件包文件是 junction 或符号链接：$RelativePath" }
  $absolute = [IO.Path]::GetFullPath($fullPath)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $absolute.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) { throw "插件路径越界：$RelativePath" }
  $entry = $Archive.CreateEntry("dsh-tavern-image/$RelativePath", [IO.Compression.CompressionLevel]::Optimal)
  $input = [IO.File]::OpenRead($absolute)
  try {
    $output = $entry.Open()
    try { $input.CopyTo($output) } finally { $output.Dispose() }
  } finally { $input.Dispose() }
}

try {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $null = New-Item -ItemType Directory -Path $BundleRoot

  $sourceStream = [IO.File]::Create($SourceZip)
  try {
    $archive = [IO.Compression.ZipArchive]::new($sourceStream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      foreach ($relative in $SourceFiles) { Add-SourceTreeToZip $archive $RepositoryRoot $relative }
      $libRoot = Join-Path $RepositoryRoot 'lib'
      $libItem = Get-Item -LiteralPath $libRoot -Force
      if ($libItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'lib 目录是 junction 或符号链接，已停止打包。' }
      $pending = [Collections.Generic.Stack[string]]::new()
      $pending.Push($libRoot)
      while ($pending.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
          if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "lib 包含 junction 或符号链接：$($item.FullName)" }
          if ($item.PSIsContainer) { $pending.Push($item.FullName) }
          else {
            $relative = $item.FullName.Substring($libRoot.Length + 1).Replace('\', '/')
            Add-SourceTreeToZip $archive $RepositoryRoot ("lib/$relative")
          }
        }
      }
    } finally { $archive.Dispose() }
  } finally { $sourceStream.Dispose() }

  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-plugin.ps1') -Destination $BundleRoot
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-DshTavernImage.cmd') -Destination $BundleRoot
  if (Test-Path -LiteralPath $OutputPath) { throw "输出文件已存在，不会覆盖：$OutputPath" }
  [IO.Compression.ZipFile]::CreateFromDirectory($BundleRoot, $OutputPath, [IO.Compression.CompressionLevel]::Optimal, $false)
  $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $RepositoryRoot 'package.json') | ConvertFrom-Json
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($OutputPath)
  try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
  Write-Host "已生成安装包：$OutputPath"
  Write-Host "插件版本：$($manifest.version)；包名：$($manifest.name)；bundle ID：dsh-tavern-image"
  Write-Host "安装包 SHA-256：$hash（本地传输核对值，不是可信远端校验值）"
} finally {
  if (Test-Path -LiteralPath $TempRoot) {
    $cleanupPath = [IO.Path]::GetFullPath($TempRoot)
    $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $cleanupPath.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $cleanupPath) -notmatch '^dsh-tavern-image-package-[a-f0-9]{32}$') { throw '打包暂存目录越界，已停止清理。' }
    $cleanupItem = Get-Item -LiteralPath $cleanupPath -Force
    if ($cleanupItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '打包暂存目录是链接，已停止清理。' }
    Remove-Item -LiteralPath $cleanupPath -Recurse -Force
  }
}
