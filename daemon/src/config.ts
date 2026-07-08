import { hostname, homedir } from 'os';
import { execSync } from 'child_process';

export interface DaemonConfig {
  vaultPath: string;
  /**
   * 표준 호스팅 git remote URL (HTTPS+토큰). 예: https://<user>:<token>@host/owner/repo.git
   * 빈 문자열 허용 — vault 에 이미 origin 이 설정돼 있으면 재사용(기기 자격증명·SSH 로 push). 부트스트랩만 REMOTE 필수.
   */
  remote: string;
  /** DEVICE_ID env 명시값. 미지정이면 undefined → Committer 가 .git 에 영속화한다. */
  deviceId?: string;
  /**
   * DISPLAY_NAME env 명시값 — git author.name 으로 사용. 미설정이면 deviceId 로 폴백.
   * 같은 기기에서 plugin 과 daemon 이 공존할 때 커밋 주체 구분에 유용(예: plugin=jaei, daemon=jaei-bot).
   */
  displayName?: string;
  debounceMs: number;
}

const DEBOUNCE_DEFAULT = 3_000;
const DEBOUNCE_MIN = 100;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'device';
}

/** deviceId 미지정 시 hostname-slug + 랜덤 4자리(base36). 같은 기종 2대의 커밋 identity 충돌 방지. */
export function defaultDeviceId(): string {
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${slug(hostname())}-${suffix}`;
}

/** daemon 커밋에 붙는 접미어 — plugin(사람) 커밋과 시각적 구분 위한 표식. */
const DAEMON_SUFFIX = '-bot';

/**
 * DISPLAY_NAME env 미지정 시 daemon 커밋 author.name 자동 감지.
 * 우선순위: git global user.name → homedir 마지막 세그먼트(/Users/foodtech → foodtech) → deviceId.
 * 검출된 이름에 `-bot` 접미어를 붙여 같은 기기의 plugin(foodtech) 과 daemon(foodtech-bot) 을 구분 가능하게 한다.
 * git 명령이 없거나 실패해도 예외를 삼키고 다음 후보로 폴백.
 */
export function defaultDaemonDisplayName(deviceId: string): string {
  let base = '';
  try {
    base = execSync('git config --global user.name', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* git 없음/미설정 — 다음 후보 */
  }
  if (!base) {
    try {
      base = (homedir().split(/[/\\]/).filter(Boolean).pop() ?? '').trim();
    } catch {
      /* homedir 불가 */
    }
  }
  if (!base) base = deviceId;
  return `${base}${DAEMON_SUFFIX}`;
}

/** 숫자 env 검증: 유한하고 min 이상이면 채택, 아니면(NaN/빈문자열/음수) 기본값. */
function positiveInt(raw: string | undefined, def: number, min: number): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : def;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const vaultPath = env.VAULT_PATH?.trim();
  if (!vaultPath) throw new Error('VAULT_PATH 환경변수 필수');
  // REMOTE 빔 허용 — vault 에 이미 origin 있으면 Committer.ensureRepo 가 재사용, 없으면 거기서 명확 에러.
  const remote = env.REMOTE?.trim() ?? '';

  return {
    vaultPath,
    remote,
    deviceId: env.DEVICE_ID?.trim() || undefined,
    displayName: env.DISPLAY_NAME?.trim() || undefined,
    debounceMs: positiveInt(env.DEBOUNCE_MS, DEBOUNCE_DEFAULT, DEBOUNCE_MIN),
  };
}
