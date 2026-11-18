# 把插件目录打成可直接分发的 zip（含 APK、内置 exe、安装脚本）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\package.ps1
#   powershell -ExecutionPolicy Bypass -File .\package.ps1 -OutDir D:\some\where
#
# 产物：<OutDir>\dsh-connect-mobile-<version>.zip（内含一层 dsh-connect-mobile/ 目录）
param(
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$PkgName = 'dsh-connect-mobile'
$Src = $PSScriptRoot
if (-not $OutDir -or $OutDir.Trim() -eq '') { $OutDir = Join-Path $Src 'dist' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

$pkg = Get-Content -LiteralPath (Join-Path $Src 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$zip = Join-Path $OutDir ($PkgName + '-' + $version + '.zip')
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

$stageRoot = Join-Path $OutDir ('_pack_' + (Get-Random -Minimum 100000 -Maximum 999999))
$stage = Join-Path $stageRoot $PkgName
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$excludeDirs  = @('.git', 'bridge\files')
$excludeFiles = @('bridge\config.json', 'bridge\bridge.pid', 'bridge\.slim-batches.json', 'bridge\ft\index.json')

Write-Host ''
Write-Host ('打包 ' + $PkgName + ' v' + $version) -ForegroundColor Cyan
Write-Host ('  源：' + $Src)

$files = Get-ChildItem -LiteralPath $Src -Recurse -File -Force
$copied = 0
foreach ($f in $files) {
  $rel = $f.FullName.Substring($Src.Length).TrimStart('\')
  $skip = $false
  foreach ($d in $excludeDirs) {
    if ($rel -eq $d -or $rel.StartsWith($d + '\')) { $skip = $true }
  }
  foreach ($x in $excludeFiles) {
    if ($rel -eq $x) { $skip = $true }
  }
  if ($rel -like '*.log') { $skip = $true }
  if ($skip) { continue }
  $dest = Join-Path $stage $rel
  $destDir = Split-Path -Parent $dest
  if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
  Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
  $copied = $copied + 1
}

$hint = '手机工作台（' + $PkgName + '）v' + $version + @'

安装（Windows）：
  右键 install.ps1 → 使用 PowerShell 运行
  或：powershell -ExecutionPolicy Bypass -File .\install.ps1

安装（macOS / Linux）：
  bash ./install.sh

卸载：
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
  bash ./install.sh --uninstall

装完要完全退出并重开 DSH 桌面端；侧栏页脚会出现「手机」按钮。
手机端装 dist\dsh-mobile-clean.apk（纯净版，无预置人设/无用户数据）。

默认装到 $DSH_HOME（~/.dsh）。自定义：-DshHome "D:\path\.dsh"
'@
Set-Content -LiteralPath (Join-Path $stage 'INSTALL.txt') -Value $hint -Encoding UTF8

Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue

$zi = Get-Item -LiteralPath $zip
$mb = [string]([Math]::Round($zi.Length / 1MB, 1))
$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
Write-Host ''
Write-Host ('✓ ' + $zip + '  (' + $mb + ' MB, ' + $copied + ' files)') -ForegroundColor Green
Write-Host ('  sha256 ' + $sha)
Write-Host ''
