# 手机工作台（dsh-connect-mobile）一键安装 —— Windows
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Copy          # 复制而不是链接
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshHome "D:\x\.dsh"
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#
# 做的事（只改 DSH 的 profile，不碰插件代码）：
#   1) <DSH_HOME>\profiles\web\local-plugins\dsh-connect-mobile  -> 本目录（junction）
#   2) <DSH_HOME>\profiles\web\node_modules\dsh-connect-mobile   -> 上面那个
#   3) <DSH_HOME>\profiles\web\package.json 补 dependencies 与 dsh.profile.bundles
#
# 说明：全程只用 cmdlet + cmd/npx，不调 .NET 静态方法（受限语言模式下会失败）。
[CmdletBinding()]
param(
  [string]$DshHome,
  [switch]$Uninstall,
  [switch]$Copy
)

$ErrorActionPreference = 'Stop'
$PkgName = 'dsh-connect-mobile'
$Src = $PSScriptRoot

if (-not $DshHome -or $DshHome.Trim() -eq '') {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
if (-not (Test-Path -LiteralPath $DshHome)) {
  Write-Host "✗ 找不到 DSH_HOME：$DshHome" -ForegroundColor Red
  Write-Host "  先启动一次 DSH 桌面端，或用 -DshHome 指定。"
  exit 1
}
$DshHome = (Resolve-Path -LiteralPath $DshHome).Path
$Profile = Join-Path $DshHome 'profiles\web'
$PkgJson = Join-Path $Profile 'package.json'
if (-not (Test-Path -LiteralPath $PkgJson)) {
  Write-Host "✗ 找不到 profile：$PkgJson" -ForegroundColor Red
  Write-Host "  先启动一次 DSH 桌面端（会自动生成 profiles\web）。"
  exit 1
}

$LinkA = Join-Path $Profile "local-plugins\$PkgName"
$LinkB = Join-Path $Profile "node_modules\$PkgName"

function Remove-LinkOrDir([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  # rmdir 对 junction / 软链只删链接本身，不会删目标内容
  cmd /c rmdir "$path" 2>$null | Out-Null
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
  return (-not (Test-Path -LiteralPath $path))
}

function Edit-Profile([string]$action) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Host "✗ 找不到 node，无法安全改写 package.json。" -ForegroundColor Red
    Write-Host "  请手动加两处："
    Write-Host "    dependencies[""$PkgName""] = ""link:./local-plugins/$PkgName"""
    Write-Host "    dsh.profile.bundles 追加 ""$PkgName"""
    exit 1
  }
  $js = @'
const fs=require('fs');
const [p,name,action]=process.argv.slice(2);
const raw=fs.readFileSync(p,'utf8');
const j=JSON.parse(raw);
j.dependencies=j.dependencies||{};
j.dsh=j.dsh||{};
j.dsh.profile=j.dsh.profile||{};
if(!Array.isArray(j.dsh.profile.bundles)) j.dsh.profile.bundles=[];
if(action==='add'){
  j.dependencies[name]='link:./local-plugins/'+name;
  if(!j.dsh.profile.bundles.includes(name)) j.dsh.profile.bundles.push(name);
}else{
  delete j.dependencies[name];
  j.dsh.profile.bundles=j.dsh.profile.bundles.filter(x=>x!==name);
}
fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
console.log('  dependencies[' + name + '] = ' + (j.dependencies[name]||'(removed)') + '   bundles = ' + j.dsh.profile.bundles.length);
'@
  $tmpJs = Join-Path $env:TEMP ("dcm-edit-" + (Get-Random -Minimum 100000 -Maximum 999999) + ".cjs")
  Set-Content -LiteralPath $tmpJs -Value $js -Encoding UTF8
  & node $tmpJs $PkgJson $PkgName $action
  Remove-Item -LiteralPath $tmpJs -Force -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) { throw "改写 package.json 失败（node exit=$LASTEXITCODE）" }
}

if ($Uninstall) {
  Write-Host ""
  Write-Host "卸载 $PkgName" -ForegroundColor Cyan
  if (Remove-LinkOrDir $LinkB) { Write-Host "  已删 node_modules\$PkgName" }
  if (Remove-LinkOrDir $LinkA) { Write-Host "  已删 local-plugins\$PkgName" }
  Edit-Profile 'remove'
  Write-Host ""
  Write-Host "✓ 已卸载。完全退出并重开 DSH 桌面端后生效。" -ForegroundColor Green
  Write-Host ""
  exit 0
}

Write-Host ""
Write-Host "手机工作台 · 安装程序" -ForegroundColor Cyan
Write-Host "  插件目录：$Src"
Write-Host "  DSH_HOME：$DshHome"

New-Item -ItemType Directory -Force -Path (Join-Path $Profile 'local-plugins') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Profile 'node_modules')  | Out-Null

Remove-LinkOrDir $LinkB | Out-Null
Remove-LinkOrDir $LinkA | Out-Null

if ($Copy) {
  Copy-Item -LiteralPath $Src -Destination $LinkA -Recurse -Force
  Write-Host "  已复制插件到 local-plugins（-Copy）"
} else {
  cmd /c mklink /J "$LinkA" "$Src" | Out-Null
  if (-not (Test-Path -LiteralPath $LinkA)) { throw "创建 junction 失败：$LinkA" }
  Write-Host "  已建立 junction：local-plugins\$PkgName -> $Src"
}
cmd /c mklink /J "$LinkB" "$LinkA" | Out-Null
if (-not (Test-Path -LiteralPath $LinkB)) { throw "创建 junction 失败：$LinkB" }
Write-Host "  已建立 junction：node_modules\$PkgName -> local-plugins\$PkgName"

Edit-Profile 'add'

if (-not (Test-Path -LiteralPath (Join-Path $LinkB 'lib\index.js'))) {
  Write-Host "✗ 装完自检失败：$LinkB\lib\index.js 不存在" -ForegroundColor Red
  exit 1
}

$apk = Join-Path $Src 'dist\dsh-mobile-clean.apk'
Write-Host ""
Write-Host "✓ 安装完成" -ForegroundColor Green
Write-Host "  插件入口：$LinkB\lib\index.js"
if (Test-Path -LiteralPath $apk) {
  $mb = [string]([Math]::Round((Get-Item -LiteralPath $apk).Length / 1MB, 1))
  Write-Host "  随包 APK：dist\dsh-mobile-clean.apk（$mb MB）"
} else {
  Write-Host "  ⚠ 随包 APK 未找到（不影响插件；面板里“下载 APK”会失效）" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "下一步："
Write-Host "  1. 完全退出并重开 DSH 桌面端（不是关窗口，要退出进程）"
Write-Host "  2. 侧栏页脚出现「手机」按钮，点开就是工作台面板"
Write-Host "  3. 手机装 dist 里的纯净版 APK，扫码或填地址连过来"
Write-Host ""
Write-Host "卸载：powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall"
Write-Host ""
