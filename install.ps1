# obsidian-git-sync 설치 (Windows / PowerShell)
#
#   플러그인:  .\install.ps1 plugin -Vault "C:\Users\me\Documents\my-vault"
#   daemon:    .\install.ps1 daemon -Vault "C:\vault" -Remote "https://github.com/OWNER/REPO.git"
#
# -Name <이름>  daemon 인스턴스 이름 (기본 vault 폴더명). vault 여러 개면 이걸로 분리
#               → 작업 obsidian-git-sync-<name>, 배치/로그도 이름별
#
# 원격 실행(공개 repo):
#   irm https://raw.githubusercontent.com/aprilslab/obsidian-git-sync/main/install.ps1 | iex; # 인자 필요 시 아래처럼
#   iwr -useb https://raw.githubusercontent.com/aprilslab/obsidian-git-sync/main/install.ps1 -OutFile install.ps1; .\install.ps1 plugin -Vault "C:\...\vault"

param(
  [Parameter(Position=0)][ValidateSet('plugin','daemon')][string]$Mode,
  [string]$Vault,
  [string]$Remote,
  [string]$Token,
  [string]$Device,
  [string]$Name,
  [string]$Repo = "https://github.com/aprilslab/obsidian-git-sync.git"
)
$ErrorActionPreference = "Stop"
function Die($m){ Write-Error "✗ $m"; exit 1 }
function Info($m){ Write-Host "→ $m" }
function Have($c){ $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }
function Slug($s){ (($s.ToLower() -replace '[^a-z0-9]+','-').Trim('-')) }

if (-not $Mode)  { Die "사용법: .\install.ps1 [plugin|daemon] -Vault <path> [...]" }
if (-not (Have git))  { Die "git 필요" }
if (-not (Have node)) { Die "Node 18+ 필요 (node --version). https://nodejs.org 또는 winget install Git.Git / OpenJS.NodeJS.LTS" }
if (-not (Have npm))  { Die "npm 필요" }
if (-not $Vault) { Die "-Vault <path> 필수" }

# ── 소스 확보 ──────────────────────────────────────────────
if ((Test-Path package.json) -and (Select-String -Path package.json -Pattern 'obsidian-git-sync' -Quiet)) {
  $Src = (Get-Location).Path
} else {
  $Src = Join-Path $env:TEMP "obsidian-git-sync-src"
  Info "소스 clone: $Repo"
  if (Test-Path $Src) { Remove-Item -Recurse -Force $Src }
  git clone --depth 1 -q $Repo $Src
}
Set-Location $Src

Info "의존성 설치 + 빌드"
npm install --silent
npm run build --silent

# ── 플러그인 ────────────────────────────────────────────────
if ($Mode -eq 'plugin') {
  if (-not (Test-Path (Join-Path $Vault ".obsidian"))) { Die "vault 에 .obsidian 없음: $Vault (Obsidian 으로 한 번 연 폴더인지 확인)" }
  $Dest = Join-Path $Vault ".obsidian\plugins\obsidian-git-sync"
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Copy-Item plugin\main.js, plugin\manifest.json, plugin\styles.css $Dest -Force
  Write-Host "✓ 플러그인 설치됨: $Dest"
  Write-Host "  다음: Obsidian → 설정 → 커뮤니티 플러그인 → 제한모드 해제 → obsidian-git-sync 활성화 → repo URL+토큰 입력 → [연결 테스트]"
  exit 0
}

# ── daemon (작업 스케줄러) ──────────────────────────────────
if (-not (Test-Path daemon\dist\index.js)) { Die "daemon 빌드 산출물 없음" }
# 인스턴스 이름 = -Name, 기본은 vault 폴더명 slug. 한 머신에 vault 여러 개면 이걸로 분리.
if (-not $Name) { $Name = Slug (Split-Path $Vault -Leaf) }
if (-not $Name) { Die "-Name 유추 실패 — -Name <이름> 명시" }
# DEVICE_ID 기본 = <computer>-<name> → vault 마다 고유 identity
if (-not $Device) { $Device = (Slug $env:COMPUTERNAME) + "-" + $Name }
$RemoteEff = $Remote
if ($Token -and $Remote) { $RemoteEff = $Remote -replace '^https://', "https://$Token@" }
if (-not $RemoteEff) {
  try { $RemoteEff = (git -C $Vault remote get-url origin) } catch {}
  if (-not $RemoteEff) { Die "daemon: -Remote <url> 필수 (vault 에 origin 도 없음)" }
  else { Info "기존 origin 재사용 (토큰 미삽입 — git credential 사용)" }
}
Info "인스턴스: $Name (device=$Device, vault=$Vault)"

$Base = "C:\obsidian-git-sync"
New-Item -ItemType Directory -Force -Path $Base | Out-Null
Copy-Item daemon\dist\index.js (Join-Path $Base "daemon.js") -Force
$NodeExe = (Get-Command node).Source

# vault별 실행 배치 + 로그 + 작업명
$Task = "obsidian-git-sync-$Name"
$Cmd  = Join-Path $Base "run-daemon-$Name.cmd"
$Log  = "$Base\daemon-$Name.log"
@"
@echo off
set VAULT_PATH=$Vault
set REMOTE=$RemoteEff
set DEVICE_ID=$Device
set DEBOUNCE_MS=3000
"$NodeExe" "$Base\daemon.js" >> "$Log" 2>&1
"@ | Set-Content -Encoding ASCII $Cmd

# 부팅 시 시작 (로그인 계정)
schtasks /Create /TN "$Task" /SC ONSTART /RU "$env:USERNAME" /TR "$Cmd" /F | Out-Null
schtasks /Run /TN "$Task" | Out-Null
Write-Host "✓ daemon 상주 시작 (작업 스케줄러: $Task)"
Write-Host "  로그: Get-Content $Log -Wait   중지: schtasks /End /TN $Task; schtasks /Delete /TN $Task /F"
Write-Host "  로그인 세션 무관 상시 실행은 NSSM 권장 — INSTALL.md §3-3 참고"
