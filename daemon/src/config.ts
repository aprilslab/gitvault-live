import { hostname } from 'os';

export interface DaemonConfig {
  vaultPath: string;
  /**
   * 표준 호스팅 git remote URL (HTTPS+토큰). 예: https://<user>:<token>@host/owner/repo.git
   * 빈 문자열 허용 — vault 에 이미 origin 이 설정돼 있으면 재사용(기기 자격증명·SSH 로 push). 부트스트랩만 REMOTE 필수.
   */
  remote: string;
  /** DEVICE_ID env 명시값. 미지정이면 undefined → Committer 가 .git 에 영속화한다. */
  deviceId?: string;
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
    debounceMs: positiveInt(env.DEBOUNCE_MS, DEBOUNCE_DEFAULT, DEBOUNCE_MIN),
  };
}
