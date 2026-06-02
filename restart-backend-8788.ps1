param(
  [int]$Port = 8788,
  [int]$HealthTimeoutSec = 20,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerRoot = Join-Path $Root 'volc-aigc-rtc-server'
$ServerEntry = Join-Path $ServerRoot 'src\server.js'
$LogDir = Join-Path $ServerRoot 'logs'
$StdoutLog = Join-Path $LogDir 'backend-8788.out.log'
$StderrLog = Join-Path $LogDir 'backend-8788.err.log'

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe',
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  throw 'node.exe not found. Please install Node.js.'
}

function Stop-PortProcess {
  param([int]$TargetPort)

  $connections = @(Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue)
  if ($connections.Count -eq 0) {
    Write-Host "[restart-backend] Port $TargetPort is not in use."
    return
  }

  $processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($processId in $processIds) {
    if (-not $processId) { continue }
    try {
      $proc = Get-Process -Id $processId -ErrorAction Stop
      Write-Host "[restart-backend] Stopping PID=$processId Name=$($proc.ProcessName) on port $TargetPort"
      Stop-Process -Id $processId -Force
    } catch {
      Write-Warning "[restart-backend] Failed to stop PID=$processId : $($_.Exception.Message)"
    }
  }

  Start-Sleep -Milliseconds 800
}

function Wait-Health {
  param(
    [string]$HealthUrl,
    [int]$TimeoutSec
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    try {
      $health = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 2
      if ($health.ok -eq $true) {
        return $health
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  throw "Backend health check timeout: $HealthUrl"
}

function Invoke-CodeEffectiveVerify {
  param([string]$BaseUrl)

  $body = @{
    text = 'verify strategy query'
    source = 'demo_button'
    sessionId = "verify_$(Get-Date -Format 'yyyyMMddHHmmss')"
    forceMock = $true
  } | ConvertTo-Json -Depth 8

  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $result = Invoke-RestMethod -Uri "$BaseUrl/api/agent/orchestrate/start" -Method Post -ContentType 'application/json; charset=utf-8' -Body $bodyBytes -TimeoutSec 30
  $events = @($result.data.events)
  $eventNames = @($events | ForEach-Object { $_.event })
  $mainReply = @($events | Where-Object { $_.event -eq 'main_reply' } | Select-Object -First 1)
  $strategyReady = @($events | Where-Object { $_.event -eq 'strategy_ready' } | Select-Object -First 1)

  $checks = [ordered]@{
    has_task_created = $eventNames -contains 'task_created'
    has_fsm_state = $eventNames -contains 'fsm_state'
    has_main_reply = $eventNames -contains 'main_reply'
    has_strategy_ready = $eventNames -contains 'strategy_ready'
    main_has_task_id = [bool]$mainReply.data.task_id
    main_popup_mode = $mainReply.data.popup_mode
    main_strategy_output_mode = $mainReply.data.strategy_output_mode
    main_needs_image = $mainReply.data.needs_image
    strategy_needs_image = $strategyReady.data.needs_image
  }

  $passed = $checks.has_task_created `
    -and $checks.has_fsm_state `
    -and $checks.has_main_reply `
    -and $checks.has_strategy_ready `
    -and $checks.main_has_task_id `
    -and ($checks.main_popup_mode -eq 'strategy_text') `
    -and ($checks.main_strategy_output_mode -eq 'text_only') `
    -and ($checks.main_needs_image -eq $false) `
    -and ($checks.strategy_needs_image -eq $false)

  [pscustomobject]@{
    passed = $passed
    checks = $checks
    task_id = $mainReply.data.task_id
    event_names = $eventNames
  }
}
if (!(Test-Path $ServerEntry)) {
  throw "Server entry not found: $ServerEntry"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Node = Find-Node
$BaseUrl = "http://127.0.0.1:$Port"

Write-Host "[restart-backend] Root: $Root"
Write-Host "[restart-backend] Node: $Node"
Write-Host "[restart-backend] Entry: $ServerEntry"

Stop-PortProcess -TargetPort $Port

Write-Host "[restart-backend] Starting backend $BaseUrl ..."
$process = Start-Process -FilePath $Node `
  -ArgumentList "`"$ServerEntry`"" `
  -WorkingDirectory $ServerRoot `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -PassThru `
  -WindowStyle Hidden

Write-Host "[restart-backend] Started PID=$($process.Id)"
Write-Host "[restart-backend] stdout: $StdoutLog"
Write-Host "[restart-backend] stderr: $StderrLog"

$health = Wait-Health -HealthUrl "$BaseUrl/health" -TimeoutSec $HealthTimeoutSec
Write-Host "[restart-backend] Health check passed: $($health.service) $($health.time)"

if (-not $SkipVerify) {
  $verify = Invoke-CodeEffectiveVerify -BaseUrl $BaseUrl
  if (-not $verify.passed) {
    Write-Warning '[restart-backend] Code verification failed, checks:'
    $verify.checks | Format-List | Out-Host
    throw 'Code verification failed. Check backend logs.'
  }

  Write-Host "[restart-backend] Code verification passed task_id=$($verify.task_id)"
  Write-Host "[restart-backend] Events: $($verify.event_names -join ', ')"
}

Write-Host '[restart-backend] Done.'
