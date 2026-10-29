# Creates a throw-away project with fake data for the DEVELOPER-SETUP tests:
# a git repo on main with a local "remote", a fake .env token, a log with a fake customer email,
# a Spring application.yml and one migration. Nothing in it is real.
#
#   powershell -ExecutionPolicy Bypass -File scripts\new-guard-test.ps1 [-Path C:\projects\POC\guard-test]
param([string]$Path = "C:\projects\POC\guard-test")
$ErrorActionPreference = 'Stop'

if (Test-Path $Path) { throw "$Path already exists. Delete it (and $Path-remote.git) or pass another -Path." }
$remote = "$Path-remote.git"

function Save($file, $text) {
  $full = Join-Path $Path $file
  New-Item -ItemType Directory -Force (Split-Path $full) | Out-Null
  [IO.File]::WriteAllText($full, $text)
}

New-Item -ItemType Directory -Force $Path | Out-Null
Save '.gitignore' ".env`n*.log`n"
Save '.env' ("API_TOKEN=ghp_FAKE" + ('0' * 32) + "`n")
Save 'app.log' "2026-10-29 ERROR order 1182 failed for jane.tester@fakecorp.dev`n2026-10-29 INFO retry ok`n"
Save 'src\main\resources\application.yml' "spring:`n  datasource:`n    url: jdbc:postgresql://localhost:5432/catalog`n    password: `${DB_PASSWORD}`n  jpa:`n    hibernate:`n      ddl-auto: validate`n"
Save 'src\main\resources\db\migration\V1__create_sku.sql' "CREATE TABLE sku (id INT PRIMARY KEY, email VARCHAR(255));`n"

git init -q --bare $remote
Push-Location $Path
try {
  git init -q -b main
  git add -A
  git -c user.name=guard-test -c user.email=guard-test@example.com commit -q -m "Test project"
  git remote add origin $remote
  git push -q -u origin main
} finally {
  Pop-Location
}
Write-Host "Created $Path (git remote: $remote). Fake data only."
