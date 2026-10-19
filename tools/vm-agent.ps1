# vm-agent.ps1 —— 把任务派给"虚拟机里的 DSH"，把回答拿回来
#
# 架构（这就是"绝对隔离"的用法）：
#   宿主 DSH（你/我）  --HTTP-->  桥（客体 8899）  -->  dsh headless "任务"  -->  回答
#   客体与宿主是**两台不同的机器**：客体读不到宿主的任何文件（不是被拦，是不存在）✓
#
# 前置（一次性，在 VM 里以 deepseek 身份完成，都不需要 sudo）：
#   1) 写 ~/dsh-bridge/bridge.py（见 docs/绝对隔离验收单.md §6）
#   2) cd ~/dsh-bridge && setsid nohup python3 bridge.py > bridge.log 2>&1 < /dev/null &
#   3) 宿主侧加端口转发：
#      VBoxManage controlvm "<VM 名>" natpf1 'vmexec,tcp,127.0.0.1,8899,,8899'
#
# 用法：
#   pwsh -File tools\vm-agent.ps1 -Task "在当前目录建 a.txt，内容是 42"
#   pwsh -File tools\vm-agent.ps1 -Task "..." -WorkDir "~/ws-1019" -Timeout 300
#   pwsh -File tools\vm-agent.ps1 -Raw "uname -a"          ← 只跑一条命令，不经过 DSH
#
# 注意：中文必须按 UTF-8 发（PowerShell 的 -Body 字符串默认 ASCII，会把中文变成问号 ✗）

param(
  [string]$Task = '',
  [string]$Raw = '',
  [string]$WorkDir = '~/ws-1019',
  [string]$Bridge = 'http://127.0.0.1:8899/',
  [string]$Token = 'BRIDGE-1019-7f3a',
  [int]$Timeout = 330
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.Encoding]::UTF8

function Invoke-Bridge([string]$cmd, [int]$sec = 120) {
  $json = @{ token = $Token; cmd = $cmd } | ConvertTo-Json -Compress
  $bytes = $utf8.GetBytes($json)      # ★ 关键：发字节，别发字符串
  $r = Invoke-RestMethod -Uri $Bridge -Method POST -Body $bytes `
    -ContentType 'application/json; charset=utf-8' -TimeoutSec $sec
  return $r
}

if (-not $Task -and -not $Raw) {
  Write-Host '用法: vm-agent.ps1 -Task "任务"  |  -Raw "命令"'
  exit 2
}

if ($Raw) {
  $r = Invoke-Bridge $Raw $Timeout
  Write-Host ('rc=' + $r.rc)
  if ($r.out) { Write-Host $r.out }
  if ($r.err) { Write-Host '--- stderr ---'; Write-Host $r.err }
  exit $(if ($r.rc -eq 0) { 0 } else { 1 })
}

# 任务里可能有引号 → 用双引号包、内部转义
$escaped = $Task.Replace('\', '\\').Replace('"', '\"')
$cmd = 'cd ' + $WorkDir + ' && dsh headless "' + $escaped + '" 2>&1'
$t0 = Get-Date
$r = Invoke-Bridge $cmd $Timeout
$sec = [Math]::Round(((Get-Date) - $t0).TotalSeconds)
Write-Host ('===== VM 里的 DSH 回答（' + $sec + ' 秒, rc=' + $r.rc + '）=====')
Write-Host $r.out
if ($r.err) { Write-Host '--- stderr ---'; Write-Host $r.err }
exit $(if ($r.rc -eq 0) { 0 } else { 1 })
