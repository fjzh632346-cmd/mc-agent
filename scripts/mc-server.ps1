# Local dedicated Minecraft server control (loopback only, offline-mode).
# Usage: powershell -File scripts\mc-server.ps1 start|stop|status [-Force]
#   Env overrides: MC_SERVER_DIR (default D:\code\MC-server),
#                  MC_SERVER_JAVA (default Zulu 17 path below).
# The server directory lives OUTSIDE the repo on purpose; this script is the
# only part that is committed. Graceful stop goes through RCON (bound to
# 127.0.0.1 because server-ip is set) so the world is saved before exit.
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'status',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$ServerDir = $env:MC_SERVER_DIR
if (-not $ServerDir) { $ServerDir = 'D:\code\MC-server' }
$JavaExe = $env:MC_SERVER_JAVA
if (-not $JavaExe) { $JavaExe = 'C:\Program Files\Zulu\zulu-17\bin\java.exe' }
$PidFile = Join-Path $ServerDir 'server.pid'
$PropsFile = Join-Path $ServerDir 'server.properties'
$LogFile = Join-Path $ServerDir 'logs\latest.log'
$RepoRoot = Split-Path $PSScriptRoot -Parent

function Get-ServerProperty([string]$key) {
  if (-not (Test-Path $PropsFile)) { return $null }
  $line = Select-String -Path $PropsFile -Pattern ("^" + [regex]::Escape($key) + "=") | Select-Object -First 1
  if ($null -eq $line) { return $null }
  return $line.Line.Substring($key.Length + 1)
}

function Get-ServerPort {
  $port = Get-ServerProperty 'server-port'
  if ($port) { return [int]$port }
  return 25565
}

function Get-ServerProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $savedPid = 0
  if (-not [int]::TryParse((Get-Content $PidFile -TotalCount 1), [ref]$savedPid)) { return $null }
  try {
    $proc = Get-Process -Id $savedPid -ErrorAction Stop
  } catch {
    return $null
  }
  if ($proc.ProcessName -ne 'java') { return $null }
  return $proc
}

function Test-PortListening([int]$port) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  return [bool]$listener
}

function Invoke-Rcon([string]$command) {
  $rconPort = Get-ServerProperty 'rcon.port'
  $rconPassword = Get-ServerProperty 'rcon.password'
  if (-not $rconPassword) {
    Write-Warning 'rcon.password not found in server.properties'
    return $false
  }
  $env:MC_RCON_PORT = $rconPort
  $env:MC_RCON_PASSWORD = $rconPassword
  try {
    & node (Join-Path $RepoRoot 'scripts\mc-rcon.js') $command
    return ($LASTEXITCODE -eq 0)
  } finally {
    Remove-Item Env:MC_RCON_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:MC_RCON_PORT -ErrorAction SilentlyContinue
  }
}

switch ($Action) {
  'start' {
    $existing = Get-ServerProcess
    if ($existing) {
      Write-Output "already running: pid=$($existing.Id) port=$(Get-ServerPort)"
      exit 0
    }
    if (-not (Test-Path (Join-Path $ServerDir 'server.jar'))) {
      Write-Error "server.jar not found in $ServerDir"
    }
    if (Test-PortListening (Get-ServerPort)) {
      Write-Error "port $(Get-ServerPort) is already in use by another process"
    }
    $proc = Start-Process -FilePath $JavaExe `
      -ArgumentList '-Xms1G', '-Xmx2G', '-jar', 'server.jar', 'nogui' `
      -WorkingDirectory $ServerDir -WindowStyle Hidden -PassThru
    Set-Content $PidFile -Value $proc.Id -Encoding ascii
    Write-Output "starting: pid=$($proc.Id), waiting for port $(Get-ServerPort) ..."
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
      if ($proc.HasExited) {
        if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 }
        Write-Error "server process exited early (code $($proc.ExitCode))"
      }
      if (Test-PortListening (Get-ServerPort)) {
        $doneLine = $null
        if (Test-Path $LogFile) {
          $doneLine = Select-String -Path $LogFile -Pattern 'Done \(' | Select-Object -Last 1
        }
        Write-Output "up: pid=$($proc.Id) port=$(Get-ServerPort)"
        if ($doneLine) { Write-Output $doneLine.Line }
        exit 0
      }
      Start-Sleep -Seconds 2
    }
    Write-Error 'timed out waiting for the server to listen (180s)'
  }
  'stop' {
    $proc = Get-ServerProcess
    if (-not $proc) {
      Write-Output 'not running'
      Remove-Item $PidFile -ErrorAction SilentlyContinue
      exit 0
    }
    Write-Output "stopping pid=$($proc.Id) via rcon ..."
    $sent = Invoke-Rcon 'stop'
    if (-not $sent) {
      if ($Force) {
        Write-Warning 'rcon stop failed; -Force given, killing process (world may lose recent changes)'
        Stop-Process -Id $proc.Id -Force
      } else {
        Write-Error 'rcon stop failed; re-run with -Force to kill the process'
      }
    }
    try {
      Wait-Process -Id $proc.Id -Timeout 90 -ErrorAction Stop
    } catch {
      if ($Force) {
        Write-Warning 'graceful stop timed out; killing process'
        Stop-Process -Id $proc.Id -Force
      } else {
        Write-Error 'server did not exit within 90s; re-run with -Force to kill it'
      }
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Output 'stopped'
    exit 0
  }
  'status' {
    $proc = Get-ServerProcess
    $port = Get-ServerPort
    if ($proc) {
      $listening = Test-PortListening $port
      Write-Output "running: pid=$($proc.Id) port=$port listening=$listening"
      if (Test-Path $LogFile) {
        $doneLine = Select-String -Path $LogFile -Pattern 'Done \(' | Select-Object -Last 1
        if ($doneLine) { Write-Output $doneLine.Line }
      }
      exit 0
    }
    Write-Output 'not running'
    exit 0
  }
}
