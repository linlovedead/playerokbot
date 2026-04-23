$projectDir = $PSScriptRoot
$distDir    = Join-Path $projectDir "dist"
$zipPath    = Join-Path $projectDir "playerok-bot-release.zip"

$jsFiles = @(
    "background.js",
    "popup.js",
    "dashboard.js",
    "orders_history.js",
    "content.js",
    "content_bridge.js",
    "content_greeting.js",
    "content_playerok.js",
    "content_steampass.js",
    "auto_boost.js",
    "auto_publisher.js",
    "card_generator.js"
)

$staticFiles = @(
    "manifest.json",
    "rules.json",
    "popup.html",
    "dashboard.html",
    "orders_history.html",
    "auto_boost.html",
    "auto_publisher.html",
    "card_generator.html",
    "item_page.html"
)

Write-Host "== PLAYEROK BOT BUILD ==" -ForegroundColor Cyan

# Clean dist
if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory -Path $distDir | Out-Null
Write-Host "[1] dist/ folder created" -ForegroundColor Green

# Copy JS files (no obfuscation)
Write-Host "[2] Copying JS files..." -ForegroundColor Yellow
foreach ($jsFile in $jsFiles) {
    $src = Join-Path $projectDir $jsFile
    $dst = Join-Path $distDir    $jsFile
    if (Test-Path $src) {
        Copy-Item $src $dst
        $s1 = [math]::Round((Get-Item $src).Length / 1KB, 0)
        Write-Host ("    {0,-35} {1,5}KB" -f $jsFile, $s1)
    } else {
        Write-Host "    [SKIP] Not found: $jsFile" -ForegroundColor DarkYellow
    }
}
Write-Host "    Done" -ForegroundColor Green

# Copy static files
Write-Host "[3] Copying HTML/JSON..." -ForegroundColor Yellow
foreach ($file in $staticFiles) {
    $src = Join-Path $projectDir $file
    $dst = Join-Path $distDir    $file
    if (Test-Path $src) {
        Copy-Item $src $dst
        Write-Host "    $file"
    } else {
        Write-Host "    [SKIP] Not found: $file" -ForegroundColor DarkYellow
    }
}
Write-Host "    Done" -ForegroundColor Green

# Create ZIP
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$distDir\*" -DestinationPath $zipPath
$zipKB = [math]::Round((Get-Item $zipPath).Length / 1KB, 0)

Write-Host ""
Write-Host "== BUILD COMPLETE ==" -ForegroundColor Green
Write-Host "   ZIP: playerok-bot-release.zip ($zipKB KB)" -ForegroundColor White
Write-Host "   Send this file to client." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to exit"
