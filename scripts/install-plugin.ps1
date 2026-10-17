[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
  [string] $Profile = 'tavern',
  [string] $SourceArchive,
  [string] $SourceDirectory,
  [Alias('Root', 'DshRoot', 'DshPath')]
  [string] $DshHome,
  [string] $DshCliPath,
  [switch] $NoRegister,
  [switch] $Quiet
)

$ErrorActionPreference = 'Stop'
$Repository = 'weixinlll/dsh-tavern-image'
$PackageName = 'dsh-tavern-comfy'
$ExpectedBundleId = 'dsh-tavern-image'
$Version = 'unknown'
$MaximumArchiveBytes = 20MB
$MaximumUncompressedBytes = 64MB
$AllowedFiles = @(
  'package.json', 'client.js', 'cordis.patch.yml', 'console.html', 'design-rules.md',
  'LICENSE', 'README.md', '世界书-通用生图规则.json', 'workflows/.gitkeep',
  'scripts/install-plugin.ps1', 'scripts/Install-DshTavernImage.cmd', 'scripts/Package-DshTavernImage.ps1'
)

function Write-Info([string] $Message) {
  if (-not $Quiet) { Write-Host $Message }
}

function Get-AbsolutePath([string] $Path) {
  return [IO.Path]::GetFullPath($Path)
}

function Get-Sha256([string] $Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Get-SourceArchive {
  if ($SourceDirectory) {
    $candidate = Get-AbsolutePath $SourceDirectory
    if (-not (Test-Path -LiteralPath (Join-Path $candidate 'package.json') -PathType Leaf)) {
      throw '指定的源码目录中没有 package.json。'
    }
    return @{ Directory = $candidate; TemporaryArchive = $null }
  }

  if (-not $SourceArchive) {
    $bundled = Join-Path $PSScriptRoot 'dsh-tavern-image-source.zip'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { $SourceArchive = $bundled }
  }

  if (-not $SourceArchive -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -PathType Leaf)) {
    $SourceDirectory = Join-Path $PSScriptRoot '..'
    return Get-SourceArchive
  }

  $downloaded = $false
  if (-not $SourceArchive) {
    $tempArchive = Join-Path ([IO.Path]::GetTempPath()) ('dsh-tavern-image-' + [guid]::NewGuid().ToString('N') + '.zip')
    $urls = @(
      'https://codeload.github.com/weixinlll/dsh-tavern-image/zip/refs/heads/master',
      'https://github.com/weixinlll/dsh-tavern-image/archive/refs/heads/master.zip'
    )
    $lastError = $null
    foreach ($url in $urls) {
      try {
        Write-Info "正在下载源码：$url"
        Invoke-WebRequest -Uri $url -OutFile $tempArchive -TimeoutSec 60
        $SourceArchive = $tempArchive
        $downloaded = $true
        break
      } catch {
        $lastError = $_
        Remove-Item -LiteralPath $tempArchive -Force -ErrorAction SilentlyContinue
      }
    }
    if (-not $SourceArchive) {
      throw "GitHub 下载失败。请在浏览器下载官方仓库 ZIP 后运行 -SourceArchive <文件路径>，或先解压/克隆后运行 -SourceDirectory <目录>。$($lastError.Exception.Message)"
    }
  }

  $archivePath = Get-AbsolutePath $SourceArchive
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "找不到 ZIP 文件：$archivePath" }
  if ((Get-Item -LiteralPath $archivePath).Length -gt $MaximumArchiveBytes) { throw '源码 ZIP 超过 20 MB 限制。' }
  $hash = Get-Sha256 $archivePath
  Write-Info "源码 ZIP SHA-256：$hash（仅供传输核对；项目未发布可信远端校验值）"
  if ($downloaded) { $script:DownloadedArchive = $archivePath }
  return @{ Archive = $archivePath; TemporaryArchive = if ($downloaded) { $archivePath } else { $null } }
}

function New-WhitelistedSourceArchive([string] $Directory, [string] $ArchivePath) {
  Add-Type -AssemblyName System.IO.Compression
  $sourceRoot = (Get-AbsolutePath $Directory).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $selected = [Collections.Generic.List[string]]::new()
  foreach ($relative in $AllowedFiles) {
    $path = Join-Path $Directory ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $item = Get-Item -LiteralPath $path -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "源码文件是 junction 或符号链接：$($item.FullName)" }
      $selected.Add($path)
    }
  }
  $libRoot = Join-Path $Directory 'lib'
  if (Test-Path -LiteralPath $libRoot -PathType Container) {
    $libRootItem = Get-Item -LiteralPath $libRoot -Force
    if ($libRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '源码 lib 目录是 junction 或符号链接。' }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($libRoot)
    while ($pending.Count -gt 0) {
      foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "源码 lib 中包含链接，已停止：$($item.FullName)" }
        if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        else { $selected.Add($item.FullName) }
      }
    }
  }
  $stream = [IO.File]::Create($ArchivePath)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      foreach ($path in $selected) {
        $absolute = Get-AbsolutePath $path
        if (-not $absolute.StartsWith($sourceRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '源码路径超出指定目录。' }
        $relative = $absolute.Substring($sourceRoot.Length).Replace('\', '/')
        $entry = $archive.CreateEntry("dsh-tavern-image/$relative", [IO.Compression.CompressionLevel]::Optimal)
        $input = [IO.File]::OpenRead($absolute)
        try {
          $output = $entry.Open()
          try { $input.CopyTo($output) } finally { $output.Dispose() }
        } finally { $input.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
}

function Get-ArchivePackageRoot([string] $ArchivePath, [string] $ExtractTo) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $safeEntries = [Collections.Generic.List[object]]::new()
    [long] $uncompressedTotal = 0
    foreach ($entry in $zip.Entries) {
      $raw = $entry.FullName.Replace('\', '/')
      $isDirectory = $raw.EndsWith('/')
      $trimmed = if ($isDirectory) { $raw.TrimEnd('/') } else { $raw }
      if (-not $trimmed -or $trimmed.StartsWith('/') -or $trimmed -match '^[A-Za-z]:' -or $trimmed.Contains([char]0)) {
        throw "ZIP 包含不安全路径：$($entry.FullName)"
      }
      $parts = $trimmed.Split('/')
      if ($parts.Where({ $_ -eq '..' -or $_ -eq '.' -or $_ -eq '' }).Count -gt 0) {
        throw "ZIP 包含不安全路径：$($entry.FullName)"
      }
      $relative = $parts -join '/'
      if (-not $isDirectory -and -not $seen.Add($relative)) { throw "ZIP 包含重复路径：$relative" }
      $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($unixType -eq 0xA000) { throw "ZIP 包含符号链接：$relative" }
      if (-not $isDirectory) {
        $uncompressedTotal += $entry.Length
        if ($entry.Length -gt $MaximumUncompressedBytes -or $uncompressedTotal -gt $MaximumUncompressedBytes) { throw 'ZIP 解压内容超过 64 MB 限制。' }
      }
      $safeEntries.Add([pscustomobject]@{ Entry = $entry; Path = $relative; Directory = $isDirectory })
    }

    $manifestCandidates = @()
    foreach ($item in $safeEntries) {
      if ($item.Directory -or (Split-Path -Leaf $item.Path) -ne 'package.json') { continue }
      if ($item.Entry.Length -gt 1048576) { continue }
      $reader = [IO.StreamReader]::new($item.Entry.Open())
      try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      if ($manifest.name -eq $PackageName) { $manifestCandidates += [pscustomobject]@{ Item = $item; Manifest = $manifest } }
    }
    if ($manifestCandidates.Count -ne 1) { throw "ZIP 中应恰有一个 $PackageName/package.json，实际找到 $($manifestCandidates.Count) 个。" }
    $manifestItem = $manifestCandidates[0].Item
    $rootPrefix = ($manifestItem.Path -replace '(^|/)package\.json$', '')
    if ($rootPrefix) { $rootPrefix += '/' }
    $manifest = $manifestCandidates[0].Manifest
    if ($manifest.main -ne 'lib/index.js' -or $manifest.dsh.bundle.patch -ne './cordis.patch.yml' -or $manifest.dsh.client.platform -ne 'web') {
      throw 'ZIP 缺少 DSH 插件入口、bundle patch 或浏览器客户端声明。'
    }
    if (-not [string]::IsNullOrWhiteSpace($manifest.version)) { $script:Version = [string]$manifest.version }

    $files = [Collections.Generic.List[object]]::new()
    foreach ($item in $safeEntries) {
      if ($item.Directory -or -not $item.Path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $relative = $item.Path.Substring($rootPrefix.Length)
      $allowed = $AllowedFiles -contains $relative -or $relative.StartsWith('lib/', [StringComparison]::Ordinal)
      if (-not $allowed) { continue }
      if ($relative.StartsWith('lib/', [StringComparison]::Ordinal) -and $relative.Split('/').Where({ $_ -eq '..' -or $_ -eq '.' -or $_ -eq '' }).Count -gt 0) {
        throw "ZIP 包含不安全的 lib 路径：$relative"
      }
      $files.Add([pscustomobject]@{ Entry = $item.Entry; Path = $relative })
    }
    foreach ($required in @('package.json', 'lib/index.js', 'client.js', 'cordis.patch.yml')) {
      if (-not ($files | Where-Object Path -eq $required)) { throw "源码包不完整，缺少 $required。" }
    }
    $patchFile = $files | Where-Object Path -eq 'cordis.patch.yml' | Select-Object -First 1
    $patchReader = [IO.StreamReader]::new($patchFile.Entry.Open())
    try { $patchText = $patchReader.ReadToEnd() } finally { $patchReader.Dispose() }
    if ($patchText -notmatch '(?m)^\s*-\s+id:\s*dsh-tavern-image\s*$') { throw "bundle id 不是 $ExpectedBundleId，已停止安装。" }

    foreach ($file in $files) {
      $destination = Get-AbsolutePath (Join-Path $ExtractTo ($file.Path.Replace('/', [IO.Path]::DirectorySeparatorChar)))
      $base = (Get-AbsolutePath $ExtractTo).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
      if (-not $destination.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw "ZIP 路径越界：$($file.Path)" }
      $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination)
      $input = $file.Entry.Open()
      try {
        $output = [IO.File]::Create($destination)
        try { $input.CopyTo($output) } finally { $output.Dispose() }
      } finally { $input.Dispose() }
    }
    return $manifest
  } finally { $zip.Dispose() }
}

function Resolve-DshCli([string] $DshDataHome) {
  if ($DshCliPath) {
    $candidate = Get-AbsolutePath $DshCliPath
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "找不到指定的 DSH CLI：$candidate" }
    return $candidate
  }
  if ($env:LOCALAPPDATA) {
    $desktopCli = Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path -LiteralPath $desktopCli -PathType Leaf) { return $desktopCli }
  }
  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) { return $command.Source }
  throw '未找到 DSH 官方 CLI。为避免只写依赖却漏掉 Profile bundle 注册，已停止安装；请先修复 DSH Desktop/CLI，再运行本脚本。'
}

function Assert-NoReparsePoint([string] $Path, [string] $StopAt) {
  $current = Get-AbsolutePath $Path
  $stop = Get-AbsolutePath $StopAt
  if (-not $current.StartsWith($stop.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and $current -ne $stop) {
    throw '安装路径不在 DSH 数据目录内。'
  }
  while ($current -and ($current -eq $stop -or $current.StartsWith($stop.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "安装路径经过 junction 或符号链接，已停止：$current" }
    }
    if ($current -eq $stop) { break }
    $parent = Split-Path -Parent $current
    if ($parent -eq $current) { break }
    $current = $parent
  }
}

function Assert-DirectChildPath([string] $Path, [string] $Parent, [string] $ExpectedName) {
  $expectedPath = Get-AbsolutePath (Join-Path $Parent $ExpectedName)
  if ((Get-AbsolutePath $Path) -ne $expectedPath) { throw '暂存或目标路径不是插件目录的直接子项。' }
}

# 数据根目录必须包含指定的 Profile，避免选中另一个 DSH 安装后误报。
function Test-DshDataRoot([string] $Path) {
  if (-not $Path) { return $false }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
  return (Test-Path -LiteralPath (Join-Path $Path 'profiles') -PathType Container)
}

function Test-DshDataHome([string] $Path, [string] $ProfileName) {
  if (-not (Test-DshDataRoot $Path)) { return $false }
  return (Test-Path -LiteralPath (Join-Path (Join-Path $Path 'profiles') $ProfileName) -PathType Container)
}

# 找出 DSH 数据目录。
# 顺序：显式参数 > DSH_HOME > 常见位置 > 各固定磁盘根下的常见目录名。
# 显式指定时，「根目录 / profiles 目录 / profiles\<profile> 目录」三种层级任选。
# 一键包或改版可能没有 .dsh 这一层（直接 根目录\profiles\...），所以这里主动找；
# 找不到就把找过的位置全列出来，并给出可复制的命令。
function Resolve-DshDataHome([string] $Given, [string] $ProfileName) {
  if ($Given) {
    $full = Get-AbsolutePath $Given
    $layers = @($full, (Split-Path -Parent $full), (Split-Path -Parent (Split-Path -Parent $full)))
    foreach ($candidate in $layers) {
      if ($candidate -and (Test-DshDataHome $candidate $ProfileName)) { return (Get-AbsolutePath $candidate) }
    }
    foreach ($candidate in $layers) {
      if ($candidate -and (Test-DshDataRoot $candidate)) {
        throw "指定的数据目录中不存在 Profile '$ProfileName'：$(Join-Path (Join-Path $candidate 'profiles') $ProfileName)。请先在 DSH Desktop 中创建并启动该 Profile。"
      }
    }
    $lines = @(
      '指定的目录下没有 profiles 文件夹：' + $full,
      '  请传 DSH 的根目录（里面直接就是 profiles 文件夹的那一层）。三种层级都能自动识别：',
      '    -DshHome "D:\dsh"    或    -Root "D:\dsh\profiles"    或    -Root "D:\dsh\profiles\' + $ProfileName + '"'
    )
    throw ($lines -join [Environment]::NewLine)
  }

  $tried = New-Object System.Collections.Generic.List[string]
  if ($env:DSH_HOME) {
    $tried.Add('$env:DSH_HOME = ' + $env:DSH_HOME)
    $environmentHome = Get-AbsolutePath $env:DSH_HOME
    $environmentLayers = @($environmentHome, (Split-Path -Parent $environmentHome), (Split-Path -Parent (Split-Path -Parent $environmentHome)))
    foreach ($candidate in $environmentLayers) {
      if ($candidate -and (Test-DshDataHome $candidate $ProfileName)) { return (Get-AbsolutePath $candidate) }
    }
  }

  $guesses = New-Object System.Collections.Generic.List[string]
  if ($env:USERPROFILE) {
    $guesses.Add((Join-Path $env:USERPROFILE '.dsh'))
    $guesses.Add((Join-Path $env:USERPROFILE 'dsh'))
  }
  if ($env:LOCALAPPDATA) { $guesses.Add((Join-Path $env:LOCALAPPDATA 'dsh')) }
  if ($env:APPDATA) { $guesses.Add((Join-Path $env:APPDATA 'dsh')) }
  try {
    foreach ($drive in [IO.DriveInfo]::GetDrives()) {
      if ($drive.DriveType -ne [IO.DriveType]::Fixed) { continue }
      if (-not $drive.IsReady) { continue }
      $driveRoot = $drive.RootDirectory.FullName
      foreach ($name in @('.dsh', 'dsh', 'DSH', 'dsh-tavern')) { $guesses.Add((Join-Path $driveRoot $name)) }
    }
  } catch { }

  foreach ($candidate in $guesses) {
    $tried.Add($candidate)
    if (Test-DshDataHome $candidate $ProfileName) { return (Get-AbsolutePath $candidate) }
  }

  $report = @("没找到包含 Profile '$ProfileName' 的 DSH 数据目录（应有 profiles\$ProfileName 文件夹）。已经找过这些位置：")
  foreach ($item in $tried) { $report += '  ' + $item }
  $report += '  一键包或改版的数据目录可能不在上面，手动指定即可（三种层级任选）：'
  $report += '    powershell -NoProfile -ExecutionPolicy Bypass -File ".\install-plugin.ps1" -DshHome "<DSH 根目录>"'
  $report += '  <DSH 根目录> 指「里面直接就是 profiles 文件夹」的那一层；传 profiles 目录或 profiles\' + $ProfileName + ' 目录也能自动识别。'
  throw ($report -join [Environment]::NewLine)
}

$movedPackage = $false
try {
  # 根目录：显式参数 > DSH_HOME > 常见位置 > 各固定磁盘的常见目录（适配没有 .dsh 这一层的布局）
  $DshHome = Resolve-DshDataHome -Given $DshHome -ProfileName $Profile
  Write-Info ('DSH 数据目录：' + $DshHome)
  $profilePath = Join-Path (Join-Path $DshHome 'profiles') $Profile
  $pluginPath = Join-Path (Join-Path (Join-Path (Join-Path $DshHome 'profile-data') $Profile) 'data\tools') 'dsh-tavern-image'
  $pluginParent = Split-Path -Parent $pluginPath
  Assert-NoReparsePoint -Path $pluginParent -StopAt $DshHome
  $null = New-Item -ItemType Directory -Force -Path $pluginParent
  Assert-NoReparsePoint -Path $pluginParent -StopAt $DshHome
  Assert-NoReparsePoint -Path $pluginPath -StopAt $pluginParent
  $existingStage = Get-ChildItem -LiteralPath $pluginParent -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '.dsh-tavern-image-stage-*' } | Select-Object -First 1
  if ($existingStage) {
    throw "发现另一个安装遗留或正在使用的暂存目录，安装器不会删除它：$($existingStage.FullName)。请确认没有其他安装正在运行后手动检查。"
  }
  if (Test-Path -LiteralPath $pluginPath) {
    $looksInstalled = Test-Path -LiteralPath (Join-Path $pluginPath 'package.json') -PathType Leaf
    $stateText = if ($looksInstalled) { '目录里有 package.json，看起来是一份已装好的插件' } else { '目录里没有 package.json，多半是上次失败留下的残留' }
    throw ("目标目录已存在，安装器不会覆盖或合并：$pluginPath（$stateText）`n" +
      "  1) 如果这是你正在用的安装：请用 DSH Tavern 的「设置 → 本地生图 → 插件更新」，不要重跑安装器。`n" +
      "  2) 如果是上次安装失败留下的残留：先删掉它，再重跑本安装器：`n" +
      "       Remove-Item -LiteralPath '$pluginPath' -Recurse -Force`n" +
      "  3) 旧版目录迁移：见 README「旧版目录迁移」一节。")
  }
  if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
    throw "Profile 不存在：$profilePath。请先在 DSH Desktop 中创建并启动该 Profile，再重试。"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $profilePath 'package.json') -PathType Leaf)) {
    throw "Profile package.json 不存在：$profilePath。为保护现有 Profile，安装器不会初始化或改写它。"
  }
  $profileManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $profilePath 'package.json') | ConvertFrom-Json
  $existingSpec = [string]$profileManifest.dependencies.$PackageName
  if (-not $existingSpec) { $existingSpec = [string]$profileManifest.devDependencies.$PackageName }
  if ($existingSpec) {
    $existingTarget = ''
    if ($existingSpec.StartsWith('link:', [StringComparison]::OrdinalIgnoreCase)) {
      $existingTarget = $existingSpec.Substring(5).Replace('/', [IO.Path]::DirectorySeparatorChar)
      if (-not [IO.Path]::IsPathRooted($existingTarget)) { $existingTarget = Join-Path $profilePath $existingTarget }
      $existingTarget = Get-AbsolutePath $existingTarget
    }
    if ($existingTarget -and -not (Test-Path -LiteralPath $existingTarget)) {
      # 失效登记：Profile 里还留着一条指向已删除目录的 link（手动删过插件目录，或上次安装失败回滚过）。
      # 这种情况必须放行，交给下面的官方 CLI 把它重新指向新目录；否则用户会永远卡在这一步。
      Write-Info "检测到失效登记：$existingSpec 指向的目录已不存在，本次安装会把它重新指向 $pluginPath。"
    } else {
      throw "Profile 已登记 $PackageName（$existingSpec）。安装器不会覆盖已有 link；请用 DSH 插件更新入口更新，或先移除 Profile 里的这条登记后重试。"
    }
  }
  $cliPath = $null
  $node = $null
  if (-not $NoRegister) {
    $cliPath = Resolve-DshCli $DshHome
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw '未找到 Node.js，无法运行 DSH CLI。请修复 DSH Desktop/Node 环境后重试。' }
  }

  $source = Get-SourceArchive
  $stageName = '.dsh-tavern-image-stage-' + [guid]::NewGuid().ToString('N')
  if ($stageName -notmatch '^\.dsh-tavern-image-stage-[a-f0-9]{32}$') { throw '暂存目录名校验失败。' }
  $stagePath = Join-Path $pluginParent $stageName
  Assert-DirectChildPath -Path $stagePath -Parent $pluginParent -ExpectedName $stageName
  Assert-NoReparsePoint -Path $stagePath -StopAt $pluginParent
  $null = New-Item -ItemType Directory -Path $stagePath
  try {
    if ($source.Directory) {
      $sourceZip = Join-Path ([IO.Path]::GetTempPath()) ('dsh-tavern-image-source-' + [guid]::NewGuid().ToString('N') + '.zip')
      $script:DownloadedArchive = $null
      try {
        New-WhitelistedSourceArchive $source.Directory $sourceZip
        $null = Get-ArchivePackageRoot $sourceZip $stagePath
      } finally { Remove-Item -LiteralPath $sourceZip -Force -ErrorAction SilentlyContinue }
    } else {
      $null = Get-ArchivePackageRoot $source.Archive $stagePath
    }
    Write-Info "插件版本：$Version；目标 Profile：$Profile"
    Write-Info "源码目录：$pluginPath"
    Write-Info '正在调用 DSH 官方包管理器注册本地 link，并关闭安装脚本执行…'
    Assert-DirectChildPath -Path $stagePath -Parent $pluginParent -ExpectedName $stageName
    Assert-NoReparsePoint -Path $pluginParent -StopAt $DshHome
    Assert-NoReparsePoint -Path $stagePath -StopAt $pluginParent
    Assert-NoReparsePoint -Path $pluginPath -StopAt $pluginParent
    if (Test-Path -LiteralPath $pluginPath) { throw "目标目录在安装过程中出现，已停止：$pluginPath" }
    Move-Item -LiteralPath $stagePath -Destination $pluginPath
    $movedPackage = $true
    if ($NoRegister) {
      $movedPackage = $false
      Write-Info '（-NoRegister）已跳过官方 CLI 注册，源码只放到目标目录。'
      Write-Info ('源码目录：' + $pluginPath)
      Write-Info '请在目标 DSH 环境里按它自己的方式启用这个目录（例如手动登记 link 或加入它的插件清单），然后完整重启 DSH。'
      return
    }
    $oldHomeValue = $env:DSH_HOME
    $oldPathValue = $env:PATH
    try {
      $env:DSH_HOME = $DshHome
      $runtimePath = Join-Path $DshHome 'runtime'
      if (Test-Path -LiteralPath $runtimePath -PathType Container) { $env:PATH = $runtimePath + [IO.Path]::PathSeparator + $env:PATH }
      $linkSpec = 'link:' + $pluginPath.Replace('\', '/')
      if ([IO.Path]::GetExtension($cliPath) -in @('.cmd', '.bat', '.ps1')) {
        & $cliPath plugin --profile $Profile add $linkSpec --ignore-scripts
      } else {
        & $node.Source $cliPath plugin --profile $Profile add $linkSpec --ignore-scripts
      }
      if ($LASTEXITCODE -ne 0) { throw "DSH 官方包管理器注册失败，退出码 $LASTEXITCODE。请修好 DSH / pnpm / 网络后重跑本安装器 —— 本次安装会自动回滚，不会留下残留目录。" }
    } finally {
      $env:DSH_HOME = $oldHomeValue
      $env:PATH = $oldPathValue
    }
    $registeredManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $profilePath 'package.json') | ConvertFrom-Json
    $registeredSpec = [string]$registeredManifest.dependencies.$PackageName
    if (-not $registeredSpec.StartsWith('link:', [StringComparison]::OrdinalIgnoreCase)) {
      throw "DSH CLI 已返回成功，但 Profile 没有登记 $PackageName 的本地 link。请修复 Profile 后重跑（本次安装会自动回滚）。"
    }
    $registeredPath = $registeredSpec.Substring(5).Replace('/', [IO.Path]::DirectorySeparatorChar)
    if (-not [IO.Path]::IsPathRooted($registeredPath)) { $registeredPath = Join-Path $profilePath $registeredPath }
    $registeredPath = Get-AbsolutePath $registeredPath
    if (-not $registeredPath.Equals((Get-AbsolutePath $pluginPath), [StringComparison]::OrdinalIgnoreCase)) {
      throw "DSH CLI 已返回成功，但 Profile link 指向其他目录：$registeredPath。请修正 Profile 后重跑（本次安装会自动回滚）。"
    }
    $nodeModulesPackage = Join-Path (Join-Path $profilePath 'node_modules') $PackageName
    if (-not (Test-Path -LiteralPath $nodeModulesPackage -PathType Container)) {
      throw "DSH CLI 已返回成功，但 node_modules 中没有 $PackageName 链接。请修复 DSH / pnpm 后重跑（本次安装会自动回滚）。"
    }
    $oldLinkPath = $env:DSH_INSTALL_LINK_PATH
    $oldTargetPath = $env:DSH_INSTALL_TARGET_PATH
    try {
      $env:DSH_INSTALL_LINK_PATH = $nodeModulesPackage
      $env:DSH_INSTALL_TARGET_PATH = $pluginPath
      $linkCheck = & $node.Source -e 'const fs=require(''fs'');const a=fs.realpathSync(process.env.DSH_INSTALL_LINK_PATH).toLowerCase();const b=fs.realpathSync(process.env.DSH_INSTALL_TARGET_PATH).toLowerCase();process.exit(a===b?0:1)'
    } finally {
      $env:DSH_INSTALL_LINK_PATH = $oldLinkPath
      $env:DSH_INSTALL_TARGET_PATH = $oldTargetPath
    }
    if ($LASTEXITCODE -ne 0) { throw "DSH CLI 已返回成功，但 node_modules/$PackageName 没有解析到插件源码目录。请修复后重跑（本次安装会自动回滚）。" }
    $registeredPackage = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $pluginPath 'package.json') | ConvertFrom-Json
    if ($registeredPackage.name -ne $PackageName -or $registeredPackage.version -ne $Version) { throw '已链接的包名或版本校验失败。请检查 Profile 后重跑（本次安装会自动回滚）。' }
    if ($registeredManifest.dsh.profile.bundles -notcontains $PackageName) {
      throw "DSH CLI 已返回成功，但 Profile bundle 列表没有 $PackageName（插件 ID $ExpectedBundleId）。请检查 DSH CLI 版本后重跑（本次安装会自动回滚）。"
    }
    Write-Info "已确认 Profile 依赖、node_modules 链接和 $PackageName bundle 均指向版本 $Version。"
    Write-Info "安装完成：包名 $PackageName；bundle ID $ExpectedBundleId。请完整退出并重新打开 DSH Desktop。"
  } finally {
    if (Test-Path -LiteralPath $stagePath) {
      Assert-DirectChildPath -Path $stagePath -Parent $pluginParent -ExpectedName $stageName
      Assert-NoReparsePoint -Path $pluginParent -StopAt $DshHome
      Assert-NoReparsePoint -Path $stagePath -StopAt $pluginParent
      Remove-Item -LiteralPath $stagePath -Recurse -Force
    }
  }
} catch {
  # 注册失败就回滚，别把半成品留在 data\tools 下：
  # ① 留着它，下次运行安装器会被「目标目录已存在」挡住，用户从此再也"装不上"；
  # ② data\tools 里出现 DSH 不认识的目录，会让启动扫描失败并清空插件清单 tools.cordis.yml。
  if ($movedPackage -and $pluginPath -and (Test-Path -LiteralPath $pluginPath)) {
    try {
      Remove-Item -LiteralPath $pluginPath -Recurse -Force
      [Console]::Error.WriteLine("已回滚：删除了这次未完成的安装目录，修正上面的问题后可以直接重跑本安装器。")
    } catch {
      [Console]::Error.WriteLine("回滚失败，请手动删除后重试：$pluginPath")
    }
  }
  [Console]::Error.WriteLine("安装未完成：$($_.Exception.Message)")
  exit 1
} finally {
  if ($script:DownloadedArchive -and (Test-Path -LiteralPath $script:DownloadedArchive)) {
    Remove-Item -LiteralPath $script:DownloadedArchive -Force -ErrorAction SilentlyContinue
  }
}
