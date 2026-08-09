# Nexara CLI push-to-talk microphone recorder (Windows 10+).
# Uses the built-in WinRT AudioGraph through PowerShell 5.1 — no installs needed.
# Records to $OutFile until $StopFile disappears (or the parent process exits).
param(
  [string]$OutFile,
  [string]$StopFile,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  try {
    $netTask.Wait(-1) | Out-Null
  } catch {
    if ($netTask.Exception -ne $null) {
      foreach ($inner in $netTask.Exception.InnerExceptions) {
        Write-Error ($inner.Message)
      }
    }
    throw
  }
  $netTask.Result
}

[Windows.Media.Audio.AudioGraph, Windows.Media.Audio, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Render.AudioRenderCategory, Windows.Media.Render, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Capture.MediaCategory, Windows.Media.Capture, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.MediaProperties.AudioEncodingQuality, Windows.Media.MediaProperties, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null

$settings = [Windows.Media.Audio.AudioGraphSettings]::new([Windows.Media.Render.AudioRenderCategory]::Media)
$settings.QuantumSizeSelectionMode = [Windows.Media.Audio.QuantumSizeSelectionMode]::SystemDefault
$graphResult = Await ([Windows.Media.Audio.AudioGraph]::CreateAsync($settings)) ([Windows.Media.Audio.CreateAudioGraphResult])
if ($graphResult.Status -ne 'Success') { throw "AudioGraph failed: $($graphResult.Status)" }
$graph = $graphResult.Graph

$deviceResult = Await ($graph.CreateDeviceInputNodeAsync([Windows.Media.Capture.MediaCategory]::Speech)) ([Windows.Media.Audio.CreateAudioDeviceInputNodeResult])
if ($deviceResult.Status -ne 'Success') { throw "Could not open the microphone: $($deviceResult.Status)" }
$input = $deviceResult.DeviceInputNode

$profile = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateWav([Windows.Media.MediaProperties.AudioEncodingQuality]::High)
New-Item -ItemType File -Path $OutFile -Force | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($OutFile)) ([Windows.Storage.StorageFile])
$fileResult = Await ($graph.CreateFileOutputNodeAsync($file, $profile)) ([Windows.Media.Audio.CreateAudioFileOutputNodeResult])
if ($fileResult.Status -ne 'Success') { throw "Could not create the recording file: $($fileResult.Status)" }
$output = $fileResult.FileOutputNode
$input.AddOutgoingConnection($output) | Out-Null

$graph.Start()
Write-Output "RECORDING"

while (-not (Test-Path -LiteralPath $StopFile)) {
  if ($ParentPid -gt 0 -and $null -eq (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 100
}

$graph.Stop()
Write-Output "DONE"
