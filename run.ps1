<#
.SYNOPSIS
  Operation script for Factorio Calculator.

.EXAMPLE
  .\run.ps1 run
  .\run.ps1 update-data -Force
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('help', 'install', 'run', 'run-local', 'run-frontend', 'run-frontend-debug', 'update-data', 'test')]
  [string]$Command = 'help',

  # Port for the local web server.
  [int]$Port = 5173,

  # update-data: rebuild even if the Factorio version is unchanged.
  [switch]$Force,

  # update-data: a specific Factorio version (e.g. 2.1.24) instead of the latest stable.
  [string]$Version
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Install-Dependencies {
  if (-not (Test-Path 'node_modules')) { npm install }
}

switch ($Command) {
  'install' { npm install }

  # The app is a static site with no backend, so these are all the same server.
  { $_ -in 'run', 'run-local', 'run-frontend' } {
    node tools/serve.mjs $Port
  }

  'run-frontend-debug' {
    Start-Process "http://localhost:$Port"
    node --inspect tools/serve.mjs $Port
  }

  'update-data' {
    Install-Dependencies
    $updateArgs = @()
    if ($Force) { $updateArgs += '--force' }
    if ($Version) { $updateArgs += '--version', $Version }
    node tools/update-data.mjs @updateArgs
  }

  'test' { node --test }

  default {
    Write-Host @'
Factorio Calculator

  .\run.ps1 run                  Serve the site at http://localhost:5173 (alias: run-local, run-frontend)
  .\run.ps1 run-frontend-debug   Serve with the Node inspector enabled and open the browser
  .\run.ps1 update-data          Regenerate site/data from the latest stable Factorio release
                                   -Force            rebuild even if already up to date
                                   -Version 2.1.24   use a specific release
  .\run.ps1 test                 Run the solver tests
  .\run.ps1 install              Install dev dependencies (only needed for update-data)

  -Port <n>                      Port for the local server (default 5173)

There is no backend and no Docker setup: the app is a static site deployed to GitHub Pages.
'@
  }
}
