<#
  安装 dsh-subagent-shield（子代理信息隔断）—— 一键安装 + 自验 + 失败自动回滚

  为什么有"自验"这一步：DSH 冷启动时，**一颗坏插件会让整棵插件树加载失败、进程直接退出**。
  所以本脚本在改完配置后**先验证**，验不过就把配置恢复原样、把插件删掉，绝不留一个起不来的环境。

  用法（一般直接双击 安装.cmd 即可）：
    安装.cmd                        # 装 + 自验；失败自动回滚
    安装.cmd -DryRun                # 只看会做什么，一个字节都不改
    安装.cmd -DshHome "D:\xxx\.dsh" # 指定 DSH_HOME（默认读环境变量或 ~\.dsh）
    安装.cmd -Profile web           # 指定 profile（默认 web）
    安装.cmd -PluginSrc "D:\src\plugin"  # 指定插件源目录（默认自动判断，见下）
#>
[CmdletBinding()]
param(
  [string]$DshHome = $env:DSH_HOME,
  [string]$Profile = 'web',
  [string]$PluginSrc,
  [switch]$DryRun,
  [switch]$NoUI
)

$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $PSCommandPath
# 插件源目录自动判断，兼容两种布局：
#   ① 分发包：<目录>\安装.cmd + <目录>\plugin\...     → 用同级的 plugin
#   ② git 仓库：<仓库>\tools\install-shield.ps1，插件就在仓库根 → 用上一级
# 都不成立时保持 ① 的取值，让后面的"源缺失"检查给出明确报错，而不是在这里静默猜。
if (-not $PluginSrc) {
  $sibling = Join-Path $Here 'plugin'
  if (Test-Path -LiteralPath (Join-Path $sibling 'lib\index.js')) { $PluginSrc = $sibling }
  else { $PluginSrc = Split-Path -Parent $Here }
}
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Head($t) { Say ''; Say "  $t" 'Cyan' }

Say ''
Say '  🐋  安装「子代理信息隔断」' 'Cyan'
Say "  ─────────────────────────────────────────────  $(if ($NoUI) { '模式：NoUI（只装宿主半区 + 浮动小窗）' } else { '模式：完整（含设置页分区）' })" 'DarkGray'

# ── 1. 定 DSH_HOME / profile ─────────────────────────────────────────────
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
$profDir = Join-Path $DshHome "profiles\$Profile"
$patch   = Join-Path $profDir 'cordis.patch.yml'
$dest    = Join-Path $profDir 'node_modules\dsh-subagent-shield'

Head '1/6 检查环境'
Say "  DSH_HOME : $DshHome"
Say "  profile  : $Profile"
if (-not (Test-Path -LiteralPath $patch)) { Say "  [×] 找不到 $patch —— DSH_HOME 或 profile 名不对。" 'Red'; exit 1 }
if (-not (Test-Path -LiteralPath (Join-Path $PluginSrc 'lib\index.js'))) { Say "  [×] 插件源缺失：$PluginSrc" 'Red'; exit 1 }

# ★ 包结构自查（安装器自己做的一道闸）
#   为什么必须有这一步：package.json 里声明了 dsh.client，但对应的客户端文件缺失时，
#   宿主启动会直接失败 —— "client-modules: N client package failed to compose"，
#   而且 `dsh --dump-config` **返回 exit 0，抓不到**。缺文件就装 = 把 DSH 弄挂。
#   所以在动手之前先 fail closed。
$pkgJsonPath = Join-Path $PluginSrc 'package.json'
$pj = $null
try { $pj = [System.IO.File]::ReadAllText($pkgJsonPath) | ConvertFrom-Json }
catch { Say "  [×] package.json 解析失败：$($_.Exception.Message)" 'Red'; exit 1 }

$declaresClient = $false
if ($pj.dsh -and ($pj.dsh.PSObject.Properties.Name -contains 'client')) { $declaresClient = $true }
if ($declaresClient) {
  $clientRel = $null
  if ($pj.exports -and ($pj.exports.PSObject.Properties.Name -contains './client')) { $clientRel = $pj.exports.'./client' }
  if (-not $clientRel) {
    Say '  [×] package.json 声明了 dsh.client，却没写 exports["./client"]。' 'Red'
    Say '      这种包装上去，宿主会在客户端合成阶段失败、直接起不来。已中止。' 'Red'
    exit 1
  }
  $clientFile = Join-Path $PluginSrc ($clientRel -replace '^\./', '' -replace '/', '\')
  if (-not (Test-Path -LiteralPath $clientFile)) {
    Say "  [×] dsh.client 声明了客户端半区，但文件不存在：$clientFile" 'Red'
    Say '      装上它宿主会启动失败（client package failed to compose），且 dump-config 查不出来。已中止。' 'Red'
    exit 1
  }
  Say "  客户端半区 : $clientRel （存在 ✅）"
}
Say '  环境 OK' 'Green'

if (Test-Path -LiteralPath $dest) { Say '  提示：检测到已安装，将先移除旧版本再装。' 'Yellow' }

# ── 2. 找 node 与 dsh CLI（用于自验）───────────────────────────────────────
$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { foreach ($c in @("$env:ProgramFiles\nodejs\node.exe")) { if (Test-Path -LiteralPath $c) { $node = $c; break } } }
if (-not $node) { Say '  [×] 找不到 node.exe（自验需要它）' 'Red'; exit 1 }

# 找 dsh CLI（自验用）—— 优先级与启动器保持一致：全局 npm 安装 > npx 缓存。
# 为什么要一致：自验必须用你**实际会启动的那一份**，否则等于用另一个版本给自己背书。
$dshBin = $null
$globalBin = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (Test-Path -LiteralPath $globalBin) { $dshBin = $globalBin }
if (-not $dshBin) {
  $dshBins = @()
  # npx 缓存根：环境变量 > npm 自己报的缓存目录 > LOCALAPPDATA 默认值。
  # 不再写死任何机器专属路径；本机若设了 npm_config_cache（npm 会自己设），这里就能命中。
  $npxRoots = @()
  if ($env:DSH_NPX_CACHE) { $npxRoots += $env:DSH_NPX_CACHE }
  if ($env:npm_config_cache) { $npxRoots += (Join-Path $env:npm_config_cache '_npx') }
  if ($env:LOCALAPPDATA) { $npxRoots += (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx') }
  foreach ($root in $npxRoots) {
    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
    $dshBins += Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js' } |
      Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-Item -LiteralPath $_ }
  }
  if ($dshBins.Count -gt 0) { $dshBin = ($dshBins | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
}
Say "  node     : $node"
Say "  dsh CLI  : $(if ($dshBin) { $dshBin } else { '(未找到，将跳过部分自验)' })"

# ── 3. 备份 + 装插件 ─────────────────────────────────────────────────────
Head '2/6 备份并安装'
$backup = "$patch.bak-shield-$Stamp"
if (-not $DryRun) {
  Copy-Item -LiteralPath $patch -Destination $backup -Force
  Say "  已备份配置 -> $backup"
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
  Copy-Item -LiteralPath $PluginSrc -Destination $dest -Recurse -Force
  Say "  已安装插件 -> $dest"

  # ── -NoUI：只装"宿主半区 + 浮动小窗"，剥掉客户端半区 ────────────────────
  # 为什么要这个开关：客户端半区（dsh.client + lib/client.js）是目前**唯一**能
  #   ① 让整个 GUI 报 "Failed to load plugins"、② 让 DSH 冷启动直接失败 的部分，
  #   而它的价值只是设置页那张表。浮动小窗是宿主经 webServer 注入的，**不依赖**它。
  # 剥掉之后：隔断、/shield 命令、/status 接口、浮动小窗全部照常。
  if ($NoUI) {
    $instPkg = Join-Path $dest 'package.json'
    $instClient = Join-Path $dest 'lib\client.js'
    try {
      $pj = [System.IO.File]::ReadAllText($instPkg) | ConvertFrom-Json
      $names = @($pj.PSObject.Properties.Name)
      if ($names -contains 'dsh') {
        $dshNames = @($pj.dsh.PSObject.Properties.Name)
        if ($dshNames -contains 'client') { $pj.dsh.PSObject.Properties.Remove('client') }
      }
      $expNames = @($pj.exports.PSObject.Properties.Name)
      if ($expNames -contains './client') { $pj.exports.PSObject.Properties.Remove('./client') }
      [System.IO.File]::WriteAllText($instPkg, ($pj | ConvertTo-Json -Depth 8) + "`n", (New-Object System.Text.UTF8Encoding($false)))
      if (Test-Path -LiteralPath $instClient) { Remove-Item -LiteralPath $instClient -Force }
      Say '  [NoUI] 已剥掉客户端半区（dsh.client / exports["./client"] / lib\client.js）' 'Yellow'
      Say '  [NoUI] 保留：隔断本体 + /shield 命令 + /status 接口 + 浮动状态小窗' 'DarkGray'
    } catch {
      Say "  [×] NoUI 剥离失败：$($_.Exception.Message)" 'Red'
      Say '      已中止（配置未改动）。' 'Red'; exit 1
    }
  }
} else {
  Say '  [DryRun] 跳过备份与复制' 'Yellow'
  if ($NoUI) { Say '  [DryRun] 将剥掉客户端半区（dsh.client / lib\client.js）' 'Yellow' }
}

# ── 4. 改 profile 补丁（幂等；正确处理 [] 模板）────────────────────────────
Head '3/6 写入 profile 补丁'
function Get-Patched([string]$text) {
  if ($text -match 'dsh-subagent-shield') { return @{ text = $text; changed = $false } }
  $lines = [System.Collections.Generic.List[string]]::new()
  foreach ($l in ($text -split "`r?`n")) { $lines.Add($l) }

  # 情况 A：模板是 []（空层）—— 必须整体替换，直接追加会写出非法 YAML
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq '[]') {
      $lines[$i] = "- insert:`n    - id: dsh-subagent-shield`n      name: dsh-subagent-shield"
      return @{ text = ($lines -join "`n"); changed = $true }
    }
  }
  # 情况 B：已有 - insert: 块 —— 追加到该块末尾
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*-\s*insert:\s*$') {
      $last = $i
      for ($j = $i + 1; $j -lt $lines.Count; $j++) {
        if ($lines[$j] -match '^\s{4,}\S') { $last = $j } elseif ($lines[$j].Trim() -eq '') { continue } else { break }
      }
      $lines.Insert($last + 1, '      name: dsh-subagent-shield')
      $lines.Insert($last + 1, '    - id: dsh-subagent-shield')
      return @{ text = ($lines -join "`n"); changed = $true }
    }
  }
  # 情况 C：什么都没有 —— 追加一个新块
  $lines.Add('- insert:')
  $lines.Add('    - id: dsh-subagent-shield')
  $lines.Add('      name: dsh-subagent-shield')
  return @{ text = ($lines -join "`n"); changed = $true }
}

$orig = [System.IO.File]::ReadAllText($patch)
$res = Get-Patched $orig
if (-not $res.changed) { Say '  补丁里已有本插件（幂等，无需改动）' 'Green' }
elseif ($DryRun) { Say '  [DryRun] 将写入下列内容：' 'Yellow'; Say $res.text 'DarkGray' }
else {
  # 无 BOM —— PS 5.1 的 Set-Content -Encoding utf8 会加 BOM，YAML 可能被拒
  [System.IO.File]::WriteAllText($patch, $res.text, (New-Object System.Text.UTF8Encoding($false)))
  Say '  已写入（无 BOM）'
}

# ── 5. 自验：解析 + 合成 + 整树加载 ───────────────────────────────────────
Head '4/6 自验'
if ($DryRun) { Say '  [DryRun] 跳过自验' 'Yellow' }
else {
  $ok = $true

  # 5a. 依赖能否按包名解析（上次就是死在这）
  #     注意：<DSH_HOME>\profiles\node_modules 是 harness 首次启动时生成的"依赖回退目录"，
  #     它还不存在时这个检查会假失败，所以先看它在不在。
  $fallback = Join-Path $DshHome 'profiles\node_modules\@deepseek-ai'
  if (-not (Test-Path -LiteralPath $fallback)) {
    Say '  ⚠ 本 DSH_HOME 还没有依赖回退目录（首次启动后由 harness 生成）' 'Yellow'
    Say '     → 跳过"包解析"检查，只做配置合成检查' 'Yellow'
  } else {
    Push-Location $profDir
    $imp = & $node -e "import('dsh-subagent-shield').then(m=>console.log('IMPORT_OK '+m.name)).catch(e=>{console.log('IMPORT_FAIL '+e.code+' '+e.message);process.exit(1)})" 2>&1
    $impExit = $LASTEXITCODE
    Pop-Location
    if ($impExit -eq 0 -and "$imp" -match 'IMPORT_OK') { Say "  ✅ 包解析通过（$imp）" 'Green' }
    else { Say "  ❌ 包解析失败：$imp" 'Red'; $ok = $false }
  }

  # 5b. 配置层合成
  if ($dshBin) {
    $env:DSH_HOME = $DshHome
    $dump = & $node $dshBin --profile $Profile --dump-config 2>&1
    $dumpExit = $LASTEXITCODE
    if ($dumpExit -eq 0 -and ("$dump" -match 'dsh-subagent-shield')) { Say '  ✅ 配置合成通过，条目已就位' 'Green' }
    else { Say "  ❌ 配置合成失败（exit=$dumpExit）" 'Red'; $ok = $false }
  } else { Say '  ⚠ 没找到 dsh CLI，跳过合成检查' 'Yellow' }

  # 5c. -NoUI：确认客户端半区确实被剥掉了
  #     这一条是"灾难预防"的直接验证：没有 dsh.client，就不可能因为客户端半区
  #     让 GUI 报 Failed to load plugins、也不可能因为缺 client.js 让冷启动失败。
  if ($ok -and $NoUI) {
    $instPkgPath = Join-Path $dest 'package.json'
    $stillDeclares = $false
    try {
      $ip = [System.IO.File]::ReadAllText($instPkgPath) | ConvertFrom-Json
      if (@($ip.PSObject.Properties.Name) -contains 'dsh' -and @($ip.dsh.PSObject.Properties.Name) -contains 'client') { $stillDeclares = $true }
      if (@($ip.exports.PSObject.Properties.Name) -contains './client') { $stillDeclares = $true }
    } catch { $stillDeclares = $true }
    $clientGone = -not (Test-Path -LiteralPath (Join-Path $dest 'lib\client.js'))
    $hostKept = Test-Path -LiteralPath (Join-Path $dest 'lib\index.js')
    $widgetKept = Test-Path -LiteralPath (Join-Path $dest 'lib\widget.js')
    if (-not $stillDeclares -and $clientGone -and $hostKept -and $widgetKept) {
      Say '  ✅ NoUI 剥离通过（无 dsh.client；宿主半区与小窗保留）' 'Green'
    } else {
      Say "  ❌ NoUI 剥离不完整（仍在声明=$stillDeclares，client.js 残留=$(-not $clientGone)）" 'Red'
      $ok = $false
    }
  }

  if (-not $ok) {
    Head '回滚'
    Copy-Item -LiteralPath $backup -Destination $patch -Force
    Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
    Say '  自验未通过，已把配置恢复原样并移除插件。' 'Yellow'
    Say "  原配置在：$backup" 'DarkGray'
    exit 1
  }
}

# ── 6. 完成 ──────────────────────────────────────────────────────────────
Head '5/6 完成'
Say '  插件已就位。**需要重启 DSH 才生效**。' 'Green'
Say ''
Say '  注意：直接双击日常用的启动器会"复用已在跑的实例"，插件不会加载。' 'Yellow'
$launcher = Get-ChildItem -Path (Join-Path $env:USERPROFILE 'Desktop') -Recurse -Filter 'launch-dsh.ps1' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($launcher) {
  Say '  用这一条重启（带 -Restart）：' 'DarkGray'
  Say "    & `"$($launcher.FullName)`" -Restart" 'White'
} else {
  Say '  先彻底关掉正在跑的 DSH，再重新启动即可。' 'DarkGray'
}

Head '6/6 装完怎么用'
Say '  · 默认行为：隔断所有窗口的子代理，父会话不受限（scope=subagents）'
Say '  · 本窗口临时开关：在输入框敲  /shield on | off | clear | status'
if ($NoUI) {
  Say '  · 本次是 **NoUI 模式**（客户端半区已剥掉）' 'Yellow'
  Say '    - 设置页里那张「信息隔断」表：**没有**（用下面的方式代替）' 'DarkGray'
  Say '    - 页面上的浮动状态小窗：**有**（实时显示拒绝次数与最近记录）' 'DarkGray'
  Say '    - 看当前配置与清单：浏览器打开  /dsh-subagent-shield/status' 'DarkGray'
  Say '    - 想改默认策略/工作区/窗口规则：直接编辑 <DSH_HOME>\subagent-shield-rules.json' 'DarkGray'
  Say '    - 想装回带界面的版本：再跑一次安装器，**不要**加 -NoUI' 'DarkGray'
} else {
  Say '  · 全局开关：设置 → 信息隔断（独立分区）'
}
Say '  · 事后账本：<DSH_HOME>\subagent-shield-audit.jsonl（每次拒绝一行）'
Say "  · 卸载/回滚：把 $backup 复制回 $patch，并删掉 $dest" 'DarkGray'
Say ''

# ── 适用边界（新装的人一定会看到）
Say ''
Say '──────────────  适用边界（务必知道）  ──────────────' 'Yellow'
Say '本插件是「工具层策略围栏」，不是内核边界。' 'Yellow'
Say ''
Say '  开箱即得（不需要虚拟机）：' 'Green'
Say '    · 子代理用工具去翻会话记录 / 缓存 / 凭据 / 附件 / 别人的产物 → 精确拦截 + 逐条落账'
Say '    · 命令里朴素写出这些路径 → 拦；可疑写法 → 不拦但留 warn（账本可查）'
Say '    · 账本篡改、配置漂移（有人关掉它）→ 都会被记下来'
Say ''
Say '  只有「高保证档」才需要换安全主体（VM / 另一个 OS 账户 / 另一台机器）：' 'Cyan'
Say '    · 你要对外声称「子代理拿不到」；或结论会被认真质疑'
Say '    · 因为子代理自己写代码读盘时，读发生在子进程里 —— 插件看不见、拦不住'
Say '    · 注意：同一个虚拟机里开两个臂 = 白搭（同一安全主体）'
Say ''
Say '  判据：拒绝文本是 Access is denied → OS 层隔离成立；是【已隔断】→ 只是本插件在拦'
Say '  细节：docs/信息流覆盖表.md · docs/硬隔离怎么做.md · docs/对抗性验证清单.md' 'Gray'
Say '────────────────────────────────────────────────' 'Yellow'
Say ''
