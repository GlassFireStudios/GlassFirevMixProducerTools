# GlassFire Field Agent. Runs every 2 minutes as SYSTEM (scheduled task
# "GlassFire Field Agent"). Each run:
#   1. fetches this machine's kit manifest from the hub (or uses the cached one offline)
#   2. downloads any kit file that is missing or changed, verifies its SHA-256, swaps it in
#   3. checks media files are present (downloads them when the manifest has a URL)
#   4. keeps the vMix start-up shortcut and the Support shortcut in place
#   5. after the licence ends (and only when vMix is not streaming/recording),
#      removes GlassFire's kit files
#   6. reports a heartbeat (vMix state, kit version, disk, clock)
# Windows PowerShell 5.1. Log: C:\ProgramData\GlassFire\agent.log

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$AgentVersion = '1.0.0'
$Base = 'C:\ProgramData\GlassFire'
# Test harness only: run against a scratch folder instead of the real install.
$TestMode = [bool]$env:GF_FIELD_BASE
if ($TestMode) { $Base = $env:GF_FIELD_BASE }
$LogFile = Join-Path $Base 'agent.log'
$StatePath = Join-Path $Base 'state.json'
$ManifestCache = Join-Path $Base 'manifest.json'
$VmixExe = @("${env:ProgramFiles(x86)}\vMix\vMix64.exe", "$env:ProgramFiles\vMix\vMix64.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$StartupLnk = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp\GlassFire vMix.lnk'
$SupportLnk = Join-Path $env:PUBLIC 'Desktop\GlassFire Support.lnk'

function Log([string]$msg) {
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item $LogFile "$LogFile.1" -Force }
    Add-Content -Path $LogFile -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg)
  } catch { }
}

# One run at a time (the task also ignores overlapping starts).
$mutex = New-Object Threading.Mutex($false, 'Global\GlassFireFieldAgent')
if (-not $mutex.WaitOne(0)) { exit 0 }

try {
  $cfg = Get-Content (Join-Path $Base 'agent.json') -Raw | ConvertFrom-Json
  $Headers = @{ Authorization = "Bearer $($cfg.token)" }
  $notes = New-Object System.Collections.ArrayList
  $state = @{ kitVersion = ''; expiredApplied = $false }
  if (Test-Path $StatePath) {
    $s = Get-Content $StatePath -Raw | ConvertFrom-Json
    $state.kitVersion = [string]$s.kitVersion
    $state.expiredApplied = [bool]$s.expiredApplied
  }

  function Hub([string]$path, [string]$method = 'GET', $body = $null) {
    $p = @{ Uri = ($cfg.hub + $path); Headers = $Headers; Method = $method; TimeoutSec = 30; UseBasicParsing = $true }
    if ($null -ne $body) { $p.Body = ($body | ConvertTo-Json -Depth 6 -Compress); $p.ContentType = 'application/json' }
    Invoke-RestMethod @p
  }
  function Sha([string]$file) { (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLower() }

  function Vmix {
    $out = @{ running = $false }
    try {
      $x = [xml](Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8088/api' -TimeoutSec 4).Content
      $v = $x.vmix
      $title = { param($n) ($v.inputs.input | Where-Object { $_.number -eq [string]$n } | Select-Object -First 1).title }
      $out = @{
        running = $true; version = [string]$v.version; edition = [string]$v.edition; preset = [string]$v.preset
        active = [string](& $title $v.active); preview = [string](& $title $v.preview)
        streaming = ([string]$v.streaming -eq 'True'); recording = ([string]$v.recording -eq 'True'); external = ([string]$v.external -eq 'True')
        overlays = @($v.overlays.overlay | Where-Object { $_.'#text' } | ForEach-Object { [string](& $title $_.'#text') })
        inputs = @($v.inputs.input).Count
      }
    } catch { }
    $out
  }
  function VmixFn([string]$fn, [string]$inputName) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 -Uri ("http://127.0.0.1:8088/api/?Function=$fn&Input=" + [uri]::EscapeDataString($inputName)) | Out-Null } catch { }
  }
  function Shortcut([string]$lnk, [string]$target, [string]$arguments, [string]$icon) {
    $w = New-Object -ComObject WScript.Shell
    $sc = $w.CreateShortcut($lnk)
    $sc.TargetPath = $target
    $sc.Arguments = $arguments
    if ($icon) { $sc.IconLocation = $icon }
    $sc.Save()
  }

  # ---- 1. manifest --------------------------------------------------------------
  $online = $true
  try {
    $m = Hub '/fm/api/manifest'
    $m | ConvertTo-Json -Depth 8 | Set-Content -Path $ManifestCache -Encoding UTF8
  } catch {
    $online = $false
    Log "hub unreachable: $($_.Exception.Message)"
    if (-not (Test-Path $ManifestCache)) { throw 'no manifest yet' }
    $m = Get-Content $ManifestCache -Raw | ConvertFrom-Json
  }
  $root = [string]$m.root
  if ($TestMode) { $root = Join-Path $Base 'root' }
  $expired = [bool]$m.licence.revoked -or ([bool]$m.licence.expired)
  if (-not $expired -and $m.licence.expiresAt) { $expired = ([datetime]$m.licence.expiresAt).ToUniversalTime() -le (Get-Date).ToUniversalTime() }
  $vm = Vmix

  # ---- 2. self-update -----------------------------------------------------------
  if ($online -and $m.agent.sha256 -and ((Sha $PSCommandPath) -ne $m.agent.sha256)) {
    try {
      $tmp = "$PSCommandPath.new"
      Invoke-WebRequest -UseBasicParsing -Uri ($cfg.hub + '/fm/agent.ps1') -OutFile $tmp -TimeoutSec 60
      if ((Sha $tmp) -eq $m.agent.sha256) { Move-Item $tmp $PSCommandPath -Force; Log 'agent updated (takes effect next run)' } else { Remove-Item $tmp -Force }
    } catch { Log "agent update failed: $($_.Exception.Message)" }
  }

  if (-not $expired) {
    # ---- 3. kit files -----------------------------------------------------------
    $changed = @()
    foreach ($f in @($m.files)) {
      $dest = Join-Path $root ($f.path -replace '/', '\')
      if ((Test-Path -LiteralPath $dest) -and ((Sha $dest) -eq $f.sha256)) { continue }
      if (-not $online) { [void]$notes.Add("waiting for the hub to update $($f.path)"); continue }
      try {
        New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
        $tmp = "$dest.gfpart"
        Invoke-WebRequest -UseBasicParsing -Headers $Headers -TimeoutSec 600 -OutFile $tmp -Uri ($cfg.hub + '/fm/api/file?path=' + [uri]::EscapeDataString($f.path))
        if ((Sha $tmp) -ne $f.sha256) { Remove-Item $tmp -Force; throw 'checksum mismatch' }
        Move-Item -LiteralPath $tmp -Destination $dest -Force
        $changed += $f
        Log "updated $($f.path)"
      } catch {
        [void]$notes.Add("could not update $($f.path): $($_.Exception.Message)")
        Log "update failed $($f.path): $($_.Exception.Message)"
      }
    }
    foreach ($f in $changed) {
      if ($f.apply -eq 'countdown') { VmixFn 'BrowserReload' 'COUNTDOWN' }
      if ($f.apply -eq 'preset') { [void]$notes.Add("New version of $(Split-Path $f.path -Leaf) is ready. GlassFire will tell you when to reopen it.") }
    }
    if ($changed.Count -gt 0 -or $state.kitVersion -ne [string]$m.version) {
      $state.kitVersion = [string]$m.version
    }

    # ---- 4. media -----------------------------------------------------------------
    $missing = @()
    foreach ($f in @($m.media)) {
      $dest = Join-Path $root ($f.path -replace '/', '\')
      $ok = (Test-Path -LiteralPath $dest) -and ((Get-Item -LiteralPath $dest).Length -eq [int64]$f.size)
      if ($ok) { continue }
      if ($online -and $f.url) {
        try {
          New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
          $tmp = "$dest.gfpart"
          Invoke-WebRequest -UseBasicParsing -TimeoutSec 7200 -OutFile $tmp -Uri $f.url
          if ((Sha $tmp) -ne $f.sha256) { Remove-Item $tmp -Force; throw 'checksum mismatch' }
          Move-Item -LiteralPath $tmp -Destination $dest -Force
          Log "downloaded media $($f.path)"
          continue
        } catch { Log "media download failed $($f.path): $($_.Exception.Message)" }
      }
      $missing += $f.path
    }

    # ---- 5. shortcuts -----------------------------------------------------------
    if ($TestMode) { } elseif ($m.startup -and $VmixExe) {
      $preset = Join-Path $root ($m.startup -replace '/', '\')
      if (Test-Path -LiteralPath $preset) { Shortcut $StartupLnk $VmixExe ('"' + $preset + '"') '' }
    }
    $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $TestMode -and $cfg.supportKey -and $edge -and -not (Test-Path $SupportLnk)) {
      Shortcut $SupportLnk $edge ("--app=$($cfg.hub)/fm/support?k=$($cfg.supportKey)") "$edge,0"
    }
  } else {
    $missing = @()
    # ---- licence ended: remove GlassFire's kit files (never while on air) ---------
    if (-not $state.expiredApplied) {
      if ($vm.streaming -or $vm.recording) {
        [void]$notes.Add('Licence ended; kit removal is waiting until vMix stops streaming and recording.')
      } else {
        foreach ($f in @($m.files)) {
          if ($f.owned -eq $false) { continue }
          $dest = Join-Path $root ($f.path -replace '/', '\')
          try { if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force; Log "removed $($f.path)" } } catch { Log "remove failed $($f.path): $($_.Exception.Message)" }
        }
        if (Test-Path $StartupLnk) { Remove-Item $StartupLnk -Force }
        $state.expiredApplied = $true
        Log 'licence ended: kit files removed'
      }
    }
  }

  $state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8

  # ---- 6. heartbeat -------------------------------------------------------------
  if ($online) {
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    $os = Get-CimInstance Win32_OperatingSystem
    $body = @{
      kitVersion = $state.kitVersion; agentVersion = $AgentVersion; hostname = $env:COMPUTERNAME
      timezone = (Get-TimeZone).Id; diskFreeGB = [math]::Round($disk.FreeSpace / 1GB, 1)
      uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
      missingMedia = @($missing); notes = @($notes); expiredApplied = $state.expiredApplied; vmix = $vm
      clientTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    try {
      $r = Hub '/fm/api/heartbeat' 'POST' $body
      $skew = [math]::Round(($body.clientTime - [int64]$r.serverTime) / 1000)
      if ([math]::Abs($skew) -gt 30) { Log "clock is off by $skew s"; w32tm /resync /nowait | Out-Null }
    } catch { Log "heartbeat failed: $($_.Exception.Message)" }
  }
} catch {
  Log "run failed: $($_.Exception.Message)"
} finally {
  $mutex.ReleaseMutex()
}
