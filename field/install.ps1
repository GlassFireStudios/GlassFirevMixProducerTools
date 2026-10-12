# GlassFire Field installer. Run once per show computer, in an Administrator
# PowerShell, with the install code from livetools > Field:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://live.glassfire.co/fm/install.ps1))) -Code ABCD-EFGH"
#
# It enrolls this computer with GlassFire, sets the clock to Eastern time, installs
# the background agent (scheduled task, every 2 minutes) and pulls the show kit.
# Remove with the same command and -Uninstall instead of -Code.
param(
  [string]$Code = '',
  [string]$Hub = 'https://live.glassfire.co',
  [string]$TimeZone = 'Eastern Standard Time',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Base = 'C:\ProgramData\GlassFire'
$TaskName = 'GlassFire Field Agent'

function Say([string]$m, [string]$color = 'Gray') { Write-Host $m -ForegroundColor $color }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Say 'Run this in PowerShell opened with "Run as administrator".' Red; return }

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp\GlassFire vMix.lnk') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $env:PUBLIC 'Desktop\GlassFire Support.lnk') -Force -ErrorAction SilentlyContinue
  Remove-Item $Base -Recurse -Force -ErrorAction SilentlyContinue
  Say 'GlassFire Field agent removed. Show files were left in place.' Green
  return
}
if (-not $Code) { Say 'Missing install code. Get one on livetools > Field.' Red; return }

Say 'GlassFire Field install' Cyan

# 1. Enroll: the one-time code becomes this computer's own token.
try {
  $r = Invoke-RestMethod -Method Post -Uri "$Hub/fm/api/enroll" -ContentType 'application/json' -TimeoutSec 30 `
    -Body (@{ code = $Code.Trim(); hostname = $env:COMPUTERNAME } | ConvertTo-Json)
} catch {
  $msg = $_.ErrorDetails.Message
  if ($msg) { try { $msg = ($msg | ConvertFrom-Json).error } catch { } } else { $msg = $_.Exception.Message }
  Say "Could not enroll: $msg" Red
  return
}
Say ("Enrolled as '{0}' ({1})" -f $r.name, $(if ($r.role -eq 'V') { 'vertical' } else { 'horizontal' })) Green

# 2. Private folder: only SYSTEM and Administrators can read the token.
New-Item -ItemType Directory -Force -Path $Base | Out-Null
icacls $Base /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
@{ hub = $r.hub; token = $r.token; supportKey = $r.supportKey; machineId = $r.machineId; name = $r.name; role = $r.role; kit = $r.kit } |
  ConvertTo-Json | Set-Content -Path (Join-Path $Base 'agent.json') -Encoding UTF8
Invoke-WebRequest -UseBasicParsing -Uri "$Hub/fm/agent.ps1" -OutFile (Join-Path $Base 'agent.ps1') -TimeoutSec 60

# 3. Clock: the auto switch and countdown run on local time.
try {
  Set-TimeZone -Id $TimeZone
  Set-Service w32time -StartupType Automatic
  Start-Service w32time -ErrorAction SilentlyContinue
  w32tm /resync /force | Out-Null
  Say "Time zone set to $TimeZone, clock synced" Green
} catch { Say "Could not set the clock: $($_.Exception.Message)" Yellow }

# 4. Background agent: at start-up and every 2 minutes, as SYSTEM.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Base 'agent.ps1') + '"')
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$boot = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($every, $boot) -Principal $principal -Settings $settings -Force | Out-Null
Say 'Background agent installed' Green

# 5. First sync now (pulls the kit; media may take a while if it downloads).
Say 'Syncing the show kit...' Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Base 'agent.ps1')
Get-Content (Join-Path $Base 'agent.log') -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Say "  $_" }
Say 'Done. The "GlassFire Support" icon is on the desktop. vMix will open the show preset at log-in.' Green
