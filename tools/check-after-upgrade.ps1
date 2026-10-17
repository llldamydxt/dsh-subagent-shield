# check-after-upgrade.ps1 —— DSH 升级后 30 秒自检
#
# 为什么需要：DSH 升级会**重新铺 profile**。实测（2026-10-17，DSH 0.2.1-rc.2）：
#   · 插件版本被回退（装的 0.9.7 → 变回 0.9.6）
#   · cordis.patch.yml 里的开关被重置（enabled: false、guardShellText: false）
# 这两件事都不会报错，插件"看起来在"其实没在防 —— 所以升级后跑一遍这个。
#
# 用法：
#   pwsh -File tools\check-after-upgrade.ps1
#   pwsh -File tools\check-after-upgrade.ps1 -DshHome "C:\Users\你\Desktop\.dsh"
#   pwsh -File tools\check-after-upgrade.ps1 -Repo "C:\path\to\dsh-subagent-shield"
#
# 退出码：0 = 全部通过；1 = 有问题（看汇总）

param(
  [string]$DshHome = '',
  [string]$Profile = 'web',
  [string]$Repo = '',
  [string]$PluginName = 'dsh-subagent-shield'
)

$ErrorActionPreference = 'Continue'
$ok = $true
function Ok   ($m) { Write-Host ("  [OK]   " + $m) -ForegroundColor Green }
function Bad  ($m) { Write-Host ("  [!!]   " + $m) -ForegroundColor Red; $script:ok = $false }
function Info ($m) { Write-Host ("         " + $m) -ForegroundColor Gray }

# ── 找 DSH_HOME ─────────────────────────────────────────────
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  elseif (Test-Path (Join-Path $HOME 'Desktop\.dsh')) { $DshHome = Join-Path $HOME 'Desktop\.dsh' }
  elseif (Test-Path (Join-Path $HOME '.dsh')) { $DshHome = Join-Path $HOME '.dsh' }
}
Write-Host ''
Write-Host 'dsh-subagent-shield · 升级后自检' -ForegroundColor Cyan
Write-Host ('DSH_HOME = ' + $DshHome)
Write-Host ''

if (-not (Test-Path $DshHome)) { Bad ("找不到 DSH_HOME：" + $DshHome); Write-Host ''; exit 1 }

# ── 1) 插件装没装、什么版本 ──────────────────────────────────
$pkgPath = Join-Path $DshHome ("profiles\" + $Profile + "\node_modules\" + $PluginName + "\package.json")
$installed = $null
if (Test-Path $pkgPath) {
  $j = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $installed = $j.version
  Ok ("已安装：v" + $installed)
  if (Test-Path (Join-Path $DshHome ("profiles\" + $Profile + "\node_modules\" + $PluginName + "\lib\index.js"))) {
    Ok '入口文件在（lib\index.js）'
  } else { Bad '入口文件缺失（lib\index.js）—— 重装一次' }
} else {
  Bad ("没装：找不到 " + $pkgPath)
}

# ── 2) 和仓库里的版本比一比（若给了 -Repo）───────────────────
if ($Repo -and (Test-Path (Join-Path $Repo 'package.json'))) {
  $rv = (Get-Content (Join-Path $Repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ($installed -and ($rv -ne $installed)) {
    Bad ("版本被回退了：装的是 v" + $installed + "，仓库里是 v" + $rv + " —— 重装一遍")
  } elseif ($installed) {
    Ok ("和仓库一致（v" + $rv + "）")
  }
}

# ── 3) 开关有没有被重置 ─────────────────────────────────────
$yml = Join-Path $DshHome ("profiles\" + $Profile + "\cordis.patch.yml")
if (Test-Path $yml) {
  $t = [System.IO.File]::ReadAllText($yml)
  $blk = [regex]::Match($t, '(?s)- id:\s*' + [regex]::Escape($PluginName) + '\s*\r?\n\s*name:\s*' + [regex]::Escape($PluginName) + '\s*\r?\n\s*config:\s*\r?\n((?:\s{4,}\S[^\r\n]*\r?\n)+)')
  if (-not $blk.Success) {
    Bad '配置里找不到本插件的 config 块（可能被升级重写了）'
  } else {
    $cfg = $blk.Groups[1].Value
    $get = { param($k) $m = [regex]::Match($cfg, '(?m)^\s*' + $k + ':\s*(\S+)'); if ($m.Success) { $m.Groups[1].Value } else { '' } }
    $enabled = & $get 'enabled'
    $guard   = & $get 'guardShellText'
    $scope   = & $get 'scope'
    if ($enabled -eq 'true') { Ok 'enabled: true（总开关开着）' } else { Bad ('enabled: ' + (if ($enabled) { $enabled } else { '缺失' }) + ' —— 插件会完全不工作') }
    if ($guard -eq 'true' -or $guard -eq '') { Ok ('guardShellText: ' + (if ($guard) { $guard } else { '默认 true' })) } else { Bad ('guardShellText: ' + $guard + ' —— 命令族护栏是关的') }
    if ($scope) { Ok ('scope: ' + $scope) } else { Info 'scope 缺省 = subagents（父会话豁免）' }
    Info ('其他键缺失会走默认值；完整清单见 docs\说明书.md「配置项」')
  }
} else {
  Bad ('找不到 ' + $yml)
}

# ── 4) 还得在界面上确认的两件事 ──────────────────────────────
Write-Host ''
Write-Host '  界面确认（脚本看不到）：' -ForegroundColor Cyan
Write-Host '   1. 设置页里有没有「信息隔断」这一节？没有 → 客户端插件没被 DSH 加载（重启或重装）'
Write-Host '   2. 右下角小窗在不在？标题是不是 🚧 信息隔断？红的说明有告警（点「知道了」消）'
Write-Host ''

# ── 汇总 ────────────────────────────────────────────────────
if ($ok) {
  Write-Host '全部通过 ✓ 拿去用吧。' -ForegroundColor Green
  Write-Host '（升级后请顺手续看一眼小窗标题：显示 🚧 信息隔断 才是对的）' -ForegroundColor Gray
  exit 0
} else {
  Write-Host '有问题 —— 常见修法：' -ForegroundColor Yellow
  Write-Host '  · 版本被回退/文件缺失：重跑安装脚本 tools\install-shield.ps1 -DshHome <你的 DSH_HOME> -Profile web'
  Write-Host '  · 开关被重置：设置页打开总开关，或把 cordis.patch.yml 里 enabled 改成 true'
  Write-Host '  · 装完还不对：重启 DSH（代码改动要重启才生效；配置改动是热加载）'
  exit 1
}
