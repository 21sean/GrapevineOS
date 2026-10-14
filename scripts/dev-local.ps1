# Start both workspaces with a supported Node version without changing the
# machine-wide Node install. Codex's bundled runtime is an optional fallback.
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$systemNode = (Get-Command node -ErrorAction SilentlyContinue).Source
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$runtime = $null
foreach ($candidate in @($systemNode, $bundledNode)) {
    if (!$candidate -or !(Test-Path -LiteralPath $candidate)) { continue }
    $version = [version]((& $candidate --version).Trim().TrimStart('v'))
    if (($version.Major -eq 22 -and $version -ge [version]'22.22.2') -or
        ($version.Major -eq 24 -and $version -ge [version]'24.15.0') -or
        $version.Major -ge 26) {
        $runtime = $candidate
        break
    }
}
if (!$runtime) { throw 'Install the Node version in .nvmrc, then run this script again.' }
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$npmCli = Join-Path (Split-Path -Parent $npmCommand) 'node_modules\npm\bin\npm-cli.js'
if (!(Test-Path -LiteralPath $npmCli)) { throw 'Cannot find npm beside npm.cmd. Repair the Node/npm installation.' }
$env:PATH = (Split-Path -Parent $runtime) + [IO.Path]::PathSeparator + $env:PATH
Write-Host "Starting Grapevine with $runtime"
Push-Location $repository
try {
    & $runtime $npmCli run dev
} finally {
    Pop-Location
}
