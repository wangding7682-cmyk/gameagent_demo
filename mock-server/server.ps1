param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8765
)

$ErrorActionPreference = "Stop"

Set-StrictMode -Version Latest

$protocolVersion = "monitor.v1"
$runtimeFile = Join-Path $PSScriptRoot "runtime_state.json"
$stateOrder = @("active", "asr", "vad", "sleep")

$stateProfile = @{
  active = @{
    legacyDelta = 1.0
    smartDelta = 1.0
    latency = @{ roomJoinMs = 0; aiPostProcessBootMs = 0; firstResponseMs = 120 }
    log = "Valid user input keeps the agent in active state."
  }
  asr = @{
    legacyDelta = 1.0
    smartDelta = 0.5
    latency = @{ roomJoinMs = 0; aiPostProcessBootMs = 120; firstResponseMs = 150 }
    log = "ASR listening state detected valid speech and starts AI post-processing."
  }
  vad = @{
    legacyDelta = 1.0
    smartDelta = 0.2
    latency = @{ roomJoinMs = 0; aiPostProcessBootMs = 520; firstResponseMs = 240 }
    log = "VAD standby state detected wake-up and restarts AI post-processing."
  }
  sleep = @{
    legacyDelta = 1.0
    smartDelta = 0.01
    latency = @{ roomJoinMs = 520; aiPostProcessBootMs = 480; firstResponseMs = 280 }
    log = "Sleep state wake-up triggers room join and AI post-processing startup."
  }
}

function New-DefaultRuntime {
  return @{
    tick = 0
    currentState = "active"
    silenceElapsed = 0
    legacyCost = 0
    smartCost = 0
    elapsedSeconds = 0
    roomId = "room-9527"
    userId = "user-boss"
  }
}

function Save-RuntimeState {
  param([hashtable]$State)
  ($State | ConvertTo-Json -Depth 8) | Set-Content -Path $runtimeFile -Encoding UTF8
}

function Load-RuntimeState {
  if (-not (Test-Path $runtimeFile)) {
    $state = New-DefaultRuntime
    Save-RuntimeState -State $state
    return $state
  }

  try {
    $obj = Get-Content -Path $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return @{
      tick = [int]$obj.tick
      currentState = [string]$obj.currentState
      silenceElapsed = [int]$obj.silenceElapsed
      legacyCost = [double]$obj.legacyCost
      smartCost = [double]$obj.smartCost
      elapsedSeconds = [int]$obj.elapsedSeconds
      roomId = [string]$obj.roomId
      userId = [string]$obj.userId
    }
  } catch {
    $state = New-DefaultRuntime
    Save-RuntimeState -State $state
    return $state
  }
}

function Get-RandomizedLatency {
  param([int]$Value)
  if ($Value -le 0) {
    return 0
  }
  $swing = 0.1 + (Get-Random -Minimum 0.0 -Maximum 0.1)
  $sign = if ((Get-Random -Minimum 0 -Maximum 2) -eq 0) { -1 } else { 1 }
  $next = [math]::Round($Value * (1 + ($sign * $swing)))
  return [int][math]::Max(0, $next)
}

function Get-NextState {
  param([string]$Current)
  $index = [array]::IndexOf($stateOrder, $Current)
  if ($index -lt 0) {
    return "active"
  }

  $roll = Get-Random -Minimum 0.0 -Maximum 1.0
  if ($roll -lt 0.38) {
    return "active"
  }
  if ($roll -lt 0.58) {
    return $stateOrder[[math]::Min($index + 1, $stateOrder.Length - 1)]
  }
  if ($roll -lt 0.76) {
    return $stateOrder[[math]::Max($index - 1, 0)]
  }
  return $Current
}

function New-MonitorSnapshot {
  param([hashtable]$SubscribePayload)

  $runtime = Load-RuntimeState
  $runtime.tick += 1
  if ($SubscribePayload.roomId) { $runtime.roomId = [string]$SubscribePayload.roomId }
  if ($SubscribePayload.userId) { $runtime.userId = [string]$SubscribePayload.userId }
  $runtime.elapsedSeconds += 5

  $runtime.currentState = Get-NextState -Current $runtime.currentState
  switch ($runtime.currentState) {
    "active" { $runtime.silenceElapsed = Get-Random -Minimum 0 -Maximum 56 }
    "asr"    { $runtime.silenceElapsed = Get-Random -Minimum 60 -Maximum 89 }
    "vad"    { $runtime.silenceElapsed = Get-Random -Minimum 90 -Maximum 117 }
    "sleep"  { $runtime.silenceElapsed = Get-Random -Minimum 118 -Maximum 121 }
    default  { $runtime.silenceElapsed = 0 }
  }

  $profile = $stateProfile[$runtime.currentState]
  $runtime.legacyCost = [math]::Round(($runtime.legacyCost + ($profile.legacyDelta * 0.18 * 5)), 2)
  $runtime.smartCost = [math]::Round(($runtime.smartCost + ($profile.smartDelta * 0.18 * 5)), 2)

  Save-RuntimeState -State $runtime

  $latency = $profile.latency
  $latencySample = @{
    fromState = $runtime.currentState
    source = "powershell-mock-server"
    roomJoinMs = Get-RandomizedLatency -Value ([int]$latency.roomJoinMs)
    aiPostProcessBootMs = Get-RandomizedLatency -Value ([int]$latency.aiPostProcessBootMs)
    firstResponseMs = Get-RandomizedLatency -Value ([int]$latency.firstResponseMs)
  }

  return @{
    type = "monitor.snapshot"
    version = $protocolVersion
    source = "powershell-mock-server"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    connected = $true
    currentState = $runtime.currentState
    silenceElapsed = $runtime.silenceElapsed
    legacyCost = $runtime.legacyCost
    smartCost = $runtime.smartCost
    elapsedSeconds = $runtime.elapsedSeconds
    latencySample = $latencySample
    logs = @(
      @{
        side = "engine"
        text = "[" + $runtime.roomId + "] " + $profile.log
      },
      @{
        side = "business"
        text = "Returned " + $protocolVersion + " snapshot to frontend, tick " + $runtime.tick + "."
        highlight = ($runtime.currentState -eq "sleep")
      }
    )
  }
}

function Write-JsonResponse {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)]$BodyObject,
    [int]$StatusCode = 200
  )

  $response = $Context.Response
  $response.StatusCode = $StatusCode
  $response.ContentType = "application/json; charset=utf-8"
  $response.Headers.Add("Access-Control-Allow-Origin", "*")
  $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
  $response.Headers.Add("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

  $json = $BodyObject | ConvertTo-Json -Depth 12
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.OutputStream.Close()
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://$HostName`:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host ("monitor mock server running at " + $prefix)
Write-Host ("health endpoint: " + $prefix + "health")
Write-Host ("snapshot endpoint: " + $prefix + "api/monitor")

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $path = $request.Url.AbsolutePath

    if ($request.HttpMethod -eq "OPTIONS") {
      Write-JsonResponse -Context $context -BodyObject @{ ok = $true } -StatusCode 204
      continue
    }

    if ($request.HttpMethod -eq "GET" -and $path -eq "/health") {
      Write-JsonResponse -Context $context -BodyObject @{
        ok = $true
        service = "monitor-mock"
        version = $protocolVersion
      }
      continue
    }

    if ($path -ne "/api/monitor") {
      Write-JsonResponse -Context $context -BodyObject @{ error = "not_found" } -StatusCode 404
      continue
    }

    if ($request.HttpMethod -eq "GET") {
      $query = $request.QueryString
      $payload = @{
        type = "monitor.subscribe"
        version = $protocolVersion
        transport = "http"
        appId = [string]$query["appId"]
        appKey = [string]$query["appKey"]
        roomId = if ([string]::IsNullOrWhiteSpace([string]$query["roomId"])) { "room-9527" } else { [string]$query["roomId"] }
        userId = if ([string]::IsNullOrWhiteSpace([string]$query["userId"])) { "user-boss" } else { [string]$query["userId"] }
      }
      $snapshot = New-MonitorSnapshot -SubscribePayload $payload
      Write-JsonResponse -Context $context -BodyObject $snapshot
      continue
    }

    if ($request.HttpMethod -eq "POST") {
      $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
      $bodyText = $reader.ReadToEnd()
      $reader.Close()

      try {
        $payloadObj = if ([string]::IsNullOrWhiteSpace($bodyText)) { @{} } else { $bodyText | ConvertFrom-Json }
      } catch {
        Write-JsonResponse -Context $context -BodyObject @{ error = "invalid_json" } -StatusCode 400
        continue
      }

      $payload = @{
        type = [string]$payloadObj.type
        version = [string]$payloadObj.version
        transport = [string]$payloadObj.transport
        appId = [string]$payloadObj.appId
        appKey = [string]$payloadObj.appKey
        roomId = [string]$payloadObj.roomId
        userId = [string]$payloadObj.userId
      }

      if ($payload.type -ne "monitor.subscribe") {
        Write-JsonResponse -Context $context -BodyObject @{ error = "invalid_type"; expected = "monitor.subscribe" } -StatusCode 400
        continue
      }

      if ($payload.version -ne $protocolVersion) {
        Write-JsonResponse -Context $context -BodyObject @{ error = "invalid_version"; expected = $protocolVersion } -StatusCode 400
        continue
      }

      if ([string]::IsNullOrWhiteSpace($payload.roomId)) { $payload.roomId = "room-9527" }
      if ([string]::IsNullOrWhiteSpace($payload.userId)) { $payload.userId = "user-boss" }

      $snapshot = New-MonitorSnapshot -SubscribePayload $payload
      Write-JsonResponse -Context $context -BodyObject $snapshot
      continue
    }

    Write-JsonResponse -Context $context -BodyObject @{ error = "method_not_allowed" } -StatusCode 405
  }
} finally {
  if ($listener.IsListening) {
    $listener.Stop()
  }
  $listener.Close()
}
