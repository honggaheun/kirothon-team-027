# 사람이 검토하고 직접 실행하는 Tripwire 설정/봉인 절차입니다.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$config = @{
 specsDir = '.kiro/specs'
 testGlobs = @('tests/tripwire/**/*.prop.test.ts')
 sourceGlobs = @('chaenggim/**/*.py','web/**/*.js')
 testDir = '.'
 timeoutSeconds = 50
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path (Get-Location) '.kiro/guard/config.json'), $config, $utf8)
node .kiro/guard/bin/cli.js check --summary
if ($LASTEXITCODE -ne 0) { throw 'Tripwire 초기 검사 실패' }
node .kiro/guard/bin/cli.js adopt notice-execution:R1.1 --test tests/tripwire/R1.1.prop.test.ts --mutant mutants/notice-execution/R1.1-m1.json
if ($LASTEXITCODE -ne 0) { throw 'R1.1 봉인 실패' }
node .kiro/guard/bin/cli.js adopt notice-execution:R2.1 --test tests/tripwire/R2.1.prop.test.ts --mutant mutants/notice-execution/R2.1-m1.json --mutant mutants/notice-execution/R2.1-m2.json
if ($LASTEXITCODE -ne 0) { throw 'R2.1 봉인 실패' }
$hooks = @{
 version = 'v1'
 hooks = @(
  @{ name='tripwire-gate-write';trigger='PreToolUse';matcher='write';action=@{type='command';command='node .kiro/guard/bin/cli.js gate'};timeout=10 },
  @{ name='tripwire-gate-shell';trigger='PreToolUse';matcher='shell';action=@{type='command';command='node .kiro/guard/bin/cli.js gate'};timeout=10 },
  @{ name='tripwire-check-write';trigger='PostToolUse';matcher='write';action=@{type='command';command='node .kiro/guard/bin/cli.js check'};timeout=60 },
  @{ name='tripwire-check-shell';trigger='PostToolUse';matcher='shell';action=@{type='command';command='node .kiro/guard/bin/cli.js check --if-changed'};timeout=60 },
  @{ name='tripwire-gate-task';trigger='PreTaskExec';action=@{type='command';command='node .kiro/guard/bin/cli.js gate'};timeout=10 },
  @{ name='tripwire-session-summary';trigger='SessionStart';action=@{type='command';command='node .kiro/guard/bin/cli.js check --if-changed --summary'};timeout=60 }
 )
} | ConvertTo-Json -Depth 8
New-Item -ItemType Directory -Force '.kiro/hooks' | Out-Null
[IO.File]::WriteAllText((Join-Path (Get-Location) '.kiro/hooks/tripwire.json'),$hooks,$utf8)
Write-Output 'Tripwire 두 기준 봉인 및 집행 hook 설치 완료. 새 Kiro 세션에서 확인하세요.'
