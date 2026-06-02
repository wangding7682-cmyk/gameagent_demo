﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿param(
  [int]$Count = 5,
  [int]$DebugBranchDelayMs = 6000,
  [string]$BaseUrl = 'http://127.0.0.1:8788',
  [string]$SessionId = ''
)

$ErrorActionPreference = 'Stop'

if (-not $SessionId) {
  $SessionId = "strategy_pool_test_$(Get-Date -Format 'yyyyMMddHHmmss')"
}

function New-StrategyPayload {
  param(
    [int]$Index,
    [string]$Session,
    [int]$DelayMs
  )

  @{
    text = "第 $Index 个测试：盲僧前期入侵怎么防，只要文字战术建议"
    source = 'demo_button'
    sessionId = $Session
    forceMock = $true
    debugBranchDelayMs = $DelayMs
  } | ConvertTo-Json -Depth 8
}

function Summarize-AgentResult {
  param(
    [int]$Index,
    [object]$Result
  )

  $events = @($Result.data.events)
  $eventNames = @($events | ForEach-Object { $_.event })
  $mainReply = @($events | Where-Object { $_.event -eq 'main_reply' } | Select-Object -First 1)
  $queued = @($events | Where-Object { $_.event -eq 'task_queued' } | Select-Object -First 1)
  $fsmStates = @(
    $events |
      Where-Object { $_.event -eq 'fsm_state' } |
      ForEach-Object { $_.data.fsm_state }
  )
  $poolEvents = @($events | Where-Object { $_.event -eq 'pool_changed' })

  [pscustomobject]@{
    index = $Index
    ok = $Result.ok
    task_id = $mainReply.data.task_id
    intent = $mainReply.data.intent
    popup_mode = $mainReply.data.popup_mode
    strategy_output_mode = $mainReply.data.strategy_output_mode
    needs_image = $mainReply.data.needs_image
    queued = [bool]$queued
    queue_position = if ($queued) { $queued.data.queue_position } else { 0 }
    fsm_states = ($fsmStates -join ' -> ')
    event_names = ($eventNames -join ', ')
    pool_changed_count = $poolEvents.Count
  }
}

Write-Host "[strategy-test] BaseUrl=$BaseUrl"
Write-Host "[strategy-test] SessionId=$SessionId Count=$Count DebugBranchDelayMs=$DebugBranchDelayMs"
Write-Host '[strategy-test] Note: first 2 strategy should enter BRANCH_EXEC, later requests should get task_queued / BRANCH_QUEUED.'

try {
  $health = Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 3
  if ($health.ok -ne $true) {
    throw 'health.ok != true'
  }
} catch {
  throw "Backend not available. Run .\restart-backend-8788.ps1 first. Error: $($_.Exception.Message)"
}

$jobs = @()
for ($i = 1; $i -le $Count; $i++) {
  $payload = New-StrategyPayload -Index $i -Session $SessionId -DelayMs $DebugBranchDelayMs
  $jobs += Start-Job -ArgumentList $BaseUrl, $payload, $i -ScriptBlock {
    param($JobBaseUrl, $JobPayload, $JobIndex)
    $started = Get-Date
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($JobPayload)
    $result = Invoke-RestMethod -Uri "$JobBaseUrl/api/agent/orchestrate/start" `
      -Method Post `
      -ContentType 'application/json; charset=utf-8' `
      -Body $bodyBytes `
      -TimeoutSec 90
    [pscustomobject]@{
      index = $JobIndex
      started_at = $started
      finished_at = Get-Date
      result = $result
    }
  }
  Start-Sleep -Milliseconds 120
}

Write-Host "[strategy-test] Sent $($jobs.Count) concurrent requests, waiting..."
Wait-Job -Job $jobs | Out-Null

$rawResults = @()
foreach ($job in $jobs) {
  try {
    $rawResults += Receive-Job -Job $job -ErrorAction Stop
  } catch {
    Write-Warning "[strategy-test] Job $($job.Id) failed: $($_.Exception.Message)"
  } finally {
    Remove-Job -Job $job -Force
  }
}

$summaries = @()
foreach ($item in ($rawResults | Sort-Object index)) {
  $summaries += Summarize-AgentResult -Index $item.index -Result $item.result
}

$summaries | Format-Table -AutoSize | Out-Host

$queuedCount = @($summaries | Where-Object { $_.queued }).Count
$badModeCount = @($summaries | Where-Object {
  $_.intent -ne 'strategy' -or
  $_.popup_mode -ne 'strategy_text' -or
  $_.strategy_output_mode -ne 'text_only' -or
  $_.needs_image -ne $false
}).Count

Write-Host "[strategy-test] queuedCount=$queuedCount badModeCount=$badModeCount"

if ($Count -gt 2 -and $queuedCount -lt 1) {
  throw 'Queue verification failed: Count > 2 but no request entered task_queued. Check backend [TaskFSM] / [AgentOrchestrator] logs.'
}

if ($badModeCount -gt 0) {
  throw 'Strategy text mode verification failed: some requests did not output strategy_text/text_only/needs_image=false.'
}

Write-Host '[strategy-test] Concurrency pool and queue logic verification passed.'
