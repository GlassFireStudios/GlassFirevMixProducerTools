<#
.SYNOPSIS
  Stand up an RTMP ingest on this vMix machine so encoders can push RTMP to it
  and vMix can pick it up as a normal Stream input.

.DESCRIPTION
  vMix cannot accept an RTMP *push*; it can only pull a stream URL. This script
  installs MediaMTX (single exe, no dependencies) as the RTMP server, locks it
  to one stream key, opens the Windows firewall, and registers a startup task
  so it survives reboots. Re-running is safe: it upgrades MediaMTX and keeps the
  existing stream key.

  You still need to open TCP 1935 inbound on the instance's AWS security group.

.EXAMPLE
  # From an elevated PowerShell on the vMix instance:
  powershell -ExecutionPolicy Bypass -File .\rtmp-ingest.ps1
  powershell -ExecutionPolicy Bypass -File .\rtmp-ingest.ps1 -StreamKey myshow123
#>
param(
  [string]$InstallDir = 'C:\mediamtx',
  [string]$StreamKey,
  [int]$RtmpPort = 1935
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on

$TaskName = 'MediaMTX RTMP ingest'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Reuse the saved key unless a new one was passed, so encoders keep working on re-run.
$keyFile = Join-Path $InstallDir 'stream-key.txt'
if (-not $StreamKey) {
  if (Test-Path $keyFile) { $StreamKey = (Get-Content $keyFile -Raw).Trim() }
  else { $StreamKey = -join ((48..57) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ }) }
}
if ($StreamKey -notmatch '^[A-Za-z0-9_-]+$') { throw "Stream key may only contain letters, digits, _ and -" }
Set-Content -Path $keyFile -Value $StreamKey -NoNewline

# Stop a previous install so the exe can be replaced.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName }
Get-Process mediamtx -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host 'Downloading latest MediaMTX...'
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/bluenviron/mediamtx/releases/latest' -Headers @{ 'User-Agent' = 'glassfire-rtmp-ingest' }
$asset = $rel.assets | Where-Object { $_.name -like '*_windows_amd64.zip' } | Select-Object -First 1
if (-not $asset) { throw "No windows_amd64 asset in MediaMTX release $($rel.tag_name)" }
$zip = Join-Path $env:TEMP $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
Write-Host "Installed MediaMTX $($rel.tag_name) to $InstallDir"

# Configure: RTMP port, log to file, and only accept the one stream key.
# Dropping the default "all_others" path means pushes to any other name are rejected.
$cfg = Join-Path $InstallDir 'mediamtx.yml'
$lines = Get-Content $cfg
$pathsAt = [Array]::FindIndex([string[]]$lines, [Predicate[string]]{ param($l) $l -match '^paths:' })
if ($pathsAt -lt 0) { throw "Could not find 'paths:' in $cfg; MediaMTX config format changed" }
$logFile = Join-Path $InstallDir 'mediamtx.log'
$lines = $lines[0..($pathsAt - 1)] | ForEach-Object {
  $_ -replace '^rtmpAddress:.*', "rtmpAddress: :$RtmpPort" `
     -replace '^logDestinations:.*', 'logDestinations: [stdout, file]' `
     -replace '^logFile:.*', "logFile: '$logFile'"
}
$lines += 'paths:'
$lines += "  ${StreamKey}:"
[IO.File]::WriteAllLines($cfg, [string[]]$lines)   # UTF-8 without BOM

if (-not (Get-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $TaskName -Direction Inbound -Protocol TCP -LocalPort $RtmpPort -Action Allow | Out-Null
}

$action = New-ScheduledTaskAction -Execute (Join-Path $InstallDir 'mediamtx.exe') -Argument "`"$cfg`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 3
if (-not (Get-NetTCPConnection -LocalPort $RtmpPort -State Listen -ErrorAction SilentlyContinue)) {
  throw "MediaMTX is not listening on $RtmpPort. Check $logFile"
}

# Public IP from instance metadata (IMDSv2), for the encoder instructions.
$ip = '<PUBLIC_IP>'
try {
  $tok = Invoke-RestMethod -Method Put -Uri 'http://169.254.169.254/latest/api/token' -Headers @{ 'X-aws-ec2-metadata-token-ttl-seconds' = '60' } -TimeoutSec 2
  $ip = Invoke-RestMethod -Uri 'http://169.254.169.254/latest/meta-data/public-ipv4' -Headers @{ 'X-aws-ec2-metadata-token' = $tok } -TimeoutSec 2
} catch { }

Write-Host ''
Write-Host '=== RTMP ingest is running ===' -ForegroundColor Green
Write-Host "Encoder (OBS etc.)  Server:     rtmp://${ip}:$RtmpPort/"
Write-Host "                    Stream key: $StreamKey"
Write-Host "                    (single URL: rtmp://${ip}:$RtmpPort/$StreamKey)"
Write-Host ''
Write-Host 'vMix: Add Input > Stream / SRT, URL:'
Write-Host "                    rtmp://127.0.0.1:$RtmpPort/$StreamKey"
Write-Host "  or, if RTMP is fussy: rtsp://127.0.0.1:8554/$StreamKey"
Write-Host ''
Write-Host "Reminder: open TCP $RtmpPort inbound on this instance's AWS security group." -ForegroundColor Yellow
Write-Host "Log: $logFile"
