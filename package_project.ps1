# PowerShell script to package nova-story clean source code into lightweight zip for AI Studio / Web upload
Param(
    [string]$OutputFile = "nova-story-source.zip"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = Get-Location }
Set-Location $scriptDir

$zipPath = Join-Path $scriptDir $OutputFile
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
    Write-Host "Removed existing $OutputFile" -ForegroundColor Yellow
}

$excludeDirs = @(
    'node_modules',
    '.git',
    'dist',
    '.pytest_cache',
    '__pycache__',
    'logs',
    '.antigravity',
    '.agents',
    '.vscode',
    '.idea',
    'backend\app\static\generated',
    'backend\app\data',
    'docs'
)

$excludeFiles = @(
    $OutputFile,
    'sql_app.db',
    'database.sqlite',
    '*.zip',
    '*.tar.gz',
    '*.log'
)

Write-Host "Gathering clean source files from $scriptDir..." -ForegroundColor Cyan

$allFiles = Get-ChildItem -Path $scriptDir -Recurse -File | Where-Object {
    $relPath = $_.FullName.Substring($scriptDir.Length + 1)
    
    # Check directory exclusions
    $skip = $false
    foreach ($dir in $excludeDirs) {
        if ($relPath -like "$dir\*" -or $relPath -like "*\$dir\*" -or $relPath -eq $dir) {
            $skip = $true
            break
        }
    }
    if ($skip) { return $false }

    # Check file exclusions
    foreach ($exFile in $excludeFiles) {
        if ($_.Name -like $exFile) {
            return $false
        }
    }

    return $true
}

Write-Host "Found $($allFiles.Count) clean source files to package. Zipping..." -ForegroundColor Cyan

# Load .NET Compression Assemblies
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipMode = [System.IO.Compression.ZipArchiveMode]::Create
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, $zipMode)

try {
    foreach ($file in $allFiles) {
        $entryName = $file.FullName.Substring($scriptDir.Length + 1).Replace('\', '/')
        $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entryName)
    }
}
finally {
    $zip.Dispose()
}

$fileSize = (Get-Item $zipPath).Length / 1MB
Write-Host "`n========================================================" -ForegroundColor Green
Write-Host " Successfully created $OutputFile!" -ForegroundColor Green
Write-Host " File count : $($allFiles.Count)" -ForegroundColor Green
Write-Host " File size  : $([math]::Round($fileSize, 2)) MB" -ForegroundColor Green
Write-Host " Location   : $zipPath" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
