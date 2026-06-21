/**
 * App-local persisted config. None of this is consensus state — it is the
 * dashboard's own preferences: node base URL, an optional BYO token (web mode),
 * resource caps + scheduler intent, the local issued-grant log, and the
 * `first_seen_at` map used to derive job elapsed time (the node row carries no
 * start time; see PLAN/03-hosting-ui.md §3.1).
 *
 * In the Tauri shell upgrade path this same shape is persisted by the Rust side
 * to the app config dir instead of localStorage, and the token is read off disk
 * from `~/.local/share/ce/api.token` rather than typed by the user.
 */

const KEY = "ce-host.config.v1";

export interface CapsConfig {
  cpuCores: number;
  memMb: number;
  maxJobs: number;
  netUpMbs?: number;
  netDownMbs?: number;
  scheduler: {
    mode: "always" | "window";
    windowStart: string; // "22:00"
    windowEnd: string; // "08:00"
    pauseOnBattery: boolean;
    pauseCpuPct?: number;
  };
}

export interface IssuedGrant {
  grantee: string;
  abilities: string[];
  nonce: number;
  expires?: string;
  token: string;
  issuedAt: number;
}

export interface AppConfig {
  baseUrl: string;
  token?: string;
  nodeName?: string;
  hostStartedAt: number; // when this dashboard first saw the node online (uptime proxy)
  caps: CapsConfig;
  grants: IssuedGrant[];
  firstSeen: Record<string, number>; // jobId -> epoch ms first seen running
}

function defaults(): AppConfig {
  return {
    // Same-origin `/ce` proxy in dev; a deployment behind a reverse proxy keeps this.
    baseUrl: "/ce",
    hostStartedAt: 0,
    caps: {
      cpuCores: 4,
      memMb: 8192,
      maxJobs: 4,
      netUpMbs: 50,
      netDownMbs: 50,
      scheduler: {
        mode: "always",
        windowStart: "22:00",
        windowEnd: "08:00",
        pauseOnBattery: false,
        pauseCpuPct: 80,
      },
    },
    grants: [],
    firstSeen: {},
  };
}

let cache: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      cache = { ...defaults(), ...(JSON.parse(raw) as Partial<AppConfig>) };
      return cache;
    }
  } catch {
    // ignore malformed storage; fall through to defaults
  }
  cache = defaults();
  return cache;
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...patch };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage may be unavailable (private mode); keep in-memory only
  }
  return next;
}

/** Record the first time a job was seen running, for elapsed derivation. */
export function noteFirstSeen(jobId: string): number {
  const cfg = loadConfig();
  if (!cfg.firstSeen[jobId]) {
    cfg.firstSeen[jobId] = Date.now();
    saveConfig({ firstSeen: cfg.firstSeen });
  }
  return cfg.firstSeen[jobId]!;
}
