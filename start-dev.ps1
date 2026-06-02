[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProjectRoot = "C:\Users\Admin\Documents\trae_projects\游戏AI助手 web demo - 测试"
$StaticPort = 8080
$BackendPort = 8788

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Game AI Assistant Dev Starter" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/5] Stop existing static server..." -ForegroundColor Yellow
Get-Process | Where-Object { $_.CommandLine -like "*http.server*$StaticPort*" } -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "  Done" -ForegroundColor Green

Write-Host "[2/5] Close Chrome browser..." -ForegroundColor Yellow
$chromeProcesses = Get-Process chrome -ErrorAction SilentlyContinue
if ($chromeProcesses) {
    Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host "  Chrome closed" -ForegroundColor Green
} else {
    Write-Host "  Chrome not running" -ForegroundColor Gray
}

Write-Host "[3/5] Clear Chrome cache..." -ForegroundColor Yellow
$cachePaths = @(
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Cache",
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Code Cache"
)
foreach ($path in $cachePaths) {
    if (Test-Path $path) {
        Remove-Item -Path "$path\*" -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  Cleared: $path" -ForegroundColor Green
    }
}

Write-Host "[4/5] Check backend service..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$BackendPort/api/rtc/voice-chat/features" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    Write-Host "  Backend OK (http://127.0.0.1:$BackendPort)" -ForegroundColor Green
} catch {
    Write-Host "  Backend NOT running! Start it first:" -ForegroundColor Red
    Write-Host "  cd '$ProjectRoot\volc-aigc-rtc-server'; npm run dev" -ForegroundColor Yellow
}

Write-Host "[5/5] Start static server on port $StaticPort..." -ForegroundColor Yellow
Set-Location $ProjectRoot
Start-Process powershell -ArgumentList "-NoExit","-Command","python -m http.server $StaticPort"
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Please open in browser:" -ForegroundColor White
Write-Host "http://localhost:$StaticPort" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Tip: If still shows 404, press Ctrl+Shift+R to force refresh" -ForegroundColor Yellow
Write-Host ""

Read-Host "Press Enter to exit"
