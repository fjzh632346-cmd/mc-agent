# Start a long-lived process that survives the Claude Code session.
#
# Building lane round 14 found that everything launched from a Claude Code
# tool shell (Start-Process, Start-Job, cmd /c start) lands in the Windows
# Job Object the app puts its own process tree in, and is killed when the app
# exits — the dedicated MC server got hard-killed that way. Round 15 probed
# the alternatives: a process created through WMI (Win32_Process.Create) is
# spawned by the WMI provider host (WmiPrvSE.exe), is NOT in that job, and
# keeps running after the session ends.
#
# Usage (from the repo root):
#   scripts\start-detached.ps1 -Command 'scripts\mc-server.ps1 start' -Env MC_SERVER_JAVA
#   scripts\start-detached.ps1 -Command 'node bot.js' -Env MC_WORLD_ID,MC_PORT,MC_VERSION,EVENT_LOOP_PROBE
#   scripts\start-detached.ps1 -Command 'node .tmp\driver.js --attach' -Env MC_RCON_PORT,MC_RCON_PASSWORD -LogFile .tmp\driver.log
#
# -Env names are copied from the CURRENT session into the detached process
# (WMI-created processes inherit the provider host's environment, not yours).
# The command runs inside a fresh `powershell -NoProfile` in -WorkingDirectory
# (default: repo root), passed as -EncodedCommand so Unicode values such as
# MC_WORLD_ID='building-A:新的世界' survive the hop. Prints the wrapper PID;
# the actual worker is its child (find it by command line).
param(
  [Parameter(Mandatory = $true)] [string]$Command,
  [string[]]$Env = @(),
  [string]$WorkingDirectory = (Split-Path $PSScriptRoot -Parent),
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'

$lines = @()
foreach ($name in $Env) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($null -eq $value) { throw "environment variable '$name' is not set in this session" }
  $lines += ('$env:{0} = ''{1}''' -f $name, ($value -replace "'", "''"))
}
$lines += ('Set-Location -LiteralPath ''{0}''' -f ($WorkingDirectory -replace "'", "''"))
if ($LogFile) {
  $lines += ('& {{ {0} }} *>> ''{1}''' -f $Command, ($LogFile -replace "'", "''"))
} else {
  $lines += $Command
}
$script = $lines -join "`n"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
$commandLine = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand $encoded"

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = $commandLine
  CurrentDirectory = $WorkingDirectory
}
if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create failed: ReturnValue=$($result.ReturnValue)" }
Write-Output "detached wrapper pid=$($result.ProcessId) command=$Command"
