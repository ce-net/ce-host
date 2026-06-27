/**
 * The single reactive store that drives every panel.
 *
 * Data flow (mirrors PLAN/03-hosting-ui.md §3):
 *  - status$       re-fetched on each /blocks/stream event (and on a slow timer)
 *  - selfHistory$  /history/:self → earnings + share ratio
 *  - jobs$         /jobs polled (3s) + merged with local first_seen + accrual map
 *  - atlas$        /atlas (10s)
 *  - txFeed        /transactions/stream SSE → per-job credit accrual (60s ring)
 *  - blockFeed     /blocks/stream SSE → height + triggers status/history refresh
 *  - grants$       /capabilities/revoked + local issued-grant log
 *
 * The store is a plain event emitter; panels subscribe to `change` and re-render.
 * No framework: fine for this volume with batched renders. The Tauri shell would
 * later feed `node.start/stop/status` events into the same store unchanged.
 */

import {
  CeClient,
  Amount,
  type AtlasEntry,
  type Balance,
  type Channel,
  type Job,
  type NodeHistory,
  type NodeStatus,
  type RevokedEntry,
  type TxEvent,
  type TxRecord,
  type BlockEvent,
} from "@ce-net/sdk";
import { loadConfig, noteFirstSeen, saveConfig } from "../lib/config.js";

export type Health = "online" | "connecting" | "offline";

/** Per-job rolling credit accrual: heartbeat/settle amounts in the last 60s. */
interface AccrualSample {
  t: number;
  base: bigint;
}

export interface StoreState {
  health: Health;
  status: NodeStatus | null;
  selfHistory: NodeHistory | null;
  jobs: Job[];
  atlas: AtlasEntry[];
  revoked: RevokedEntry[];
  lastBlock: BlockEvent | null;
  /** jobId -> first-seen epoch ms (for elapsed). */
  firstSeen: Record<string, number>;
  /** Origin (node id) -> credits/min estimate, base units bigint. */
  accrualByOrigin: Map<string, bigint>;
  /** Self credits/min estimate (base units). */
  selfCreditsPerMin: bigint;
  /** Newest-last ring of the self credits/min estimate (base units), for a live sparkline. */
  selfCreditsPerMinHistory: bigint[];
  /** "removing" jobs (kill issued, awaiting next poll). */
  removing: Set<string>;
  /** Credit balance breakdown (total / free / locked-channels / locked-bond / bond). */
  balance: Balance | null;
  /** Newest-first credit transaction history for self (from GET /transactions/:self). */
  txHistory: TxRecord[];
  /** Whether the node serves GET /transactions/:id (older nodes 404 → we hide history). */
  historyAvailable: boolean;
  /** Open payment channels (GET /channels). */
  channels: Channel[];
  /** Newest-first ring of recently observed blocks (from /blocks/stream), for the Explorer. */
  recentBlocks: BlockEvent[];
  /** Newest-first ring of recently observed transactions of every kind (from /transactions/stream). */
  recentTx: TxEvent[];
  error: string | null;
}

type Listener = () => void;

const ACCRUAL_WINDOW_MS = 60_000;

export class Store {
  client: CeClient;
  state: StoreState;
  private listeners = new Set<Listener>();
  private timers: number[] = [];
  private abort = new AbortController();
  /** Per-origin sliding window of accrual samples. */
  private samples = new Map<string, AccrualSample[]>();
  private selfId = "";

  constructor() {
    const cfg = loadConfig();
    this.client = makeClient(cfg.baseUrl, cfg.token);
    this.state = {
      health: "connecting",
      status: null,
      selfHistory: null,
      jobs: [],
      atlas: [],
      revoked: [],
      lastBlock: null,
      firstSeen: { ...cfg.firstSeen },
      accrualByOrigin: new Map(),
      selfCreditsPerMin: 0n,
      selfCreditsPerMinHistory: [],
      removing: new Set(),
      balance: null,
      txHistory: [],
      historyAvailable: true,
      channels: [],
      recentBlocks: [],
      recentTx: [],
      error: null,
    };
  }

  /** Cap for the Explorer's live rings — bounded so memory stays flat over long sessions. */
  private static readonly BLOCK_RING = 40;
  private static readonly TX_RING = 60;
  private static readonly RATE_RING = 48;

  /** Rebuild the client (e.g. after the user sets a base URL / token in web mode). */
  reconfigure(baseUrl: string, token?: string): void {
    saveConfig(token !== undefined ? { baseUrl, token } : { baseUrl });
    this.client = makeClient(baseUrl, token);
    this.start();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /** (Re)start all polling + streams. Safe to call again on reconfigure. */
  start(): void {
    this.stop();
    this.abort = new AbortController();
    void this.refreshStatus();
    void this.refreshJobs();
    void this.refreshAtlas();
    void this.refreshRevoked();
    void this.refreshWallet();
    this.timers.push(window.setInterval(() => void this.refreshStatus(), 15_000));
    this.timers.push(window.setInterval(() => void this.refreshJobs(), 3_000));
    this.timers.push(window.setInterval(() => void this.refreshAtlas(), 10_000));
    this.timers.push(window.setInterval(() => void this.refreshWallet(), 15_000));
    this.timers.push(window.setInterval(() => this.recomputeAccrual(), 5_000));
    this.streamBlocks();
    this.streamTransactions();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.abort.abort();
  }

  // ---- fetches ----

  private async refreshStatus(): Promise<void> {
    try {
      const ok = await this.client.health();
      if (!ok) {
        this.set({ health: "offline" });
        return;
      }
      const status = await this.client.getStatus();
      this.selfId = status.nodeId;
      // Uptime proxy: first time we ever saw the node online via this dashboard.
      const cfg = loadConfig();
      if (!cfg.hostStartedAt) saveConfig({ hostStartedAt: Date.now() });
      let selfHistory: NodeHistory | null = this.state.selfHistory;
      try {
        selfHistory = await this.client.history(status.nodeId);
      } catch {
        // history may be unavailable on a brand-new node; keep prior
      }
      this.set({ health: "online", status, selfHistory, error: null });
    } catch (e) {
      this.set({ health: "offline", error: errMsg(e) });
    }
  }

  private async refreshJobs(): Promise<void> {
    try {
      const jobs = await this.client.listJobs();
      const firstSeen = { ...this.state.firstSeen };
      for (const j of jobs) {
        if (j.status === "running") firstSeen[j.jobId] = noteFirstSeen(j.jobId);
      }
      // Clear "removing" flags for jobs that have disappeared.
      const present = new Set(jobs.map((j) => j.jobId));
      const removing = new Set([...this.state.removing].filter((id) => present.has(id)));
      this.set({ jobs, firstSeen, removing });
    } catch (e) {
      this.set({ error: errMsg(e) });
    }
  }

  private async refreshAtlas(): Promise<void> {
    try {
      const atlas = await this.client.atlas();
      this.set({ atlas });
    } catch {
      // atlas only populates while mining; tolerate empty
    }
  }

  private async refreshRevoked(): Promise<void> {
    try {
      const revoked = await this.client.capabilities.revoked();
      this.set({ revoked });
    } catch {
      // tolerate
    }
  }

  /**
   * Refresh the credit-wallet view: balance breakdown (/status), open channels (/channels),
   * and the newest page of self transaction history (/transactions/:self). History needs the
   * self node id, so it runs once we know it; the endpoint is absent on older nodes (404) — we
   * flag `historyAvailable=false` so the panel shows an honest "unavailable" note instead of an
   * error, mirroring the CLI's graceful degradation.
   */
  private async refreshWallet(): Promise<void> {
    try {
      const balance = await this.client.wallet.balance();
      this.set({ balance });
    } catch {
      // balance is part of /status; tolerate transient failures
    }
    try {
      const channels = await this.client.wallet.listChannels();
      this.set({ channels });
    } catch {
      // channels endpoint may be empty/unavailable; tolerate
    }
    if (this.selfId) {
      try {
        const txHistory = await this.client.wallet.transactions(this.selfId, { limit: 50 });
        this.set({ txHistory, historyAvailable: true });
      } catch (e) {
        // A 404 means this node build predates GET /transactions/:id — degrade gracefully.
        if (errMsg(e).includes("404")) this.set({ historyAvailable: false });
      }
    }
  }

  /** Page older transactions (cursor = oldest visible height) and append to the history. */
  async loadOlderTx(beforeHeight: number): Promise<void> {
    if (!this.selfId) return;
    try {
      const older = await this.client.wallet.transactions(this.selfId, {
        before: beforeHeight,
        limit: 50,
      });
      if (older.length > 0) {
        this.set({ txHistory: [...this.state.txHistory, ...older] });
      }
    } catch (e) {
      this.set({ error: errMsg(e) });
    }
  }

  /** Transfer credits, then optimistically refresh the wallet view. Throws on failure. */
  async transfer(to: string, amount: Amount): Promise<string> {
    const txId = await this.client.wallet.transfer(to, amount);
    void this.refreshWallet();
    return txId;
  }

  // ---- streams ----

  private streamBlocks(): void {
    void (async () => {
      try {
        for await (const blk of this.client.streams.blocks({
          signal: this.abort.signal,
          reconnect: true,
        })) {
          // Prepend into the Explorer ring (dedupe by block hash; keep newest first).
          const recentBlocks = this.state.recentBlocks.some((b) => b.hash === blk.hash)
            ? this.state.recentBlocks
            : [blk, ...this.state.recentBlocks].slice(0, Store.BLOCK_RING);
          this.set({ lastBlock: blk, recentBlocks });
          // A new block lands → re-pull authoritative status + self history.
          void this.refreshStatus();
        }
      } catch {
        // aborted or stream ended; restart handled by next start()
      }
    })();
  }

  private streamTransactions(): void {
    void (async () => {
      try {
        for await (const tx of this.client.streams.transactions({
          signal: this.abort.signal,
          reconnect: true,
        })) {
          this.recordTx(tx);
        }
      } catch {
        // aborted or stream ended
      }
    })();
  }

  /** Feed a tx into the per-origin accrual ring (heartbeats + settlements). */
  private recordTx(tx: TxEvent): void {
    // Explorer live feed: every kind, newest first, deduped by tx id, ring-bounded.
    if (!this.state.recentTx.some((r) => r.id === tx.id)) {
      this.set({ recentTx: [tx, ...this.state.recentTx].slice(0, Store.TX_RING) });
    }

    // Live-tail any tx that touches self into the wallet history (prepend, newest first).
    // The stream frame only carries { id, origin, kind, amount }; we derive direction the way
    // ce.wallet.streamTransactions would (origin === self → out, else in) and mark height 0
    // (pending) until the authoritative paged fetch supersedes it.
    if (this.selfId && (tx.origin === this.selfId || tx.kind === "Transfer" || tx.kind === "JobSettle")) {
      const out: TxRecord = {
        txId: tx.id,
        height: 0,
        kind: tx.kind,
        amount: tx.amount,
        counterparty: tx.origin === this.selfId ? null : tx.origin,
        direction: tx.origin === this.selfId ? "out" : "in",
      };
      // Dedupe by tx id; keep the ring bounded.
      if (!this.state.txHistory.some((r) => r.txId === out.txId)) {
        this.set({ txHistory: [out, ...this.state.txHistory].slice(0, 200) });
      }
    }

    if (tx.kind !== "Heartbeat" && tx.kind !== "JobSettle" && tx.kind !== "UptimeReward") {
      return;
    }
    const arr = this.samples.get(tx.origin) ?? [];
    arr.push({ t: Date.now(), base: tx.amount.base });
    this.samples.set(tx.origin, arr);
  }

  /** Recompute the 60s rolling credits/min per origin, drop stale samples. */
  private recomputeAccrual(): void {
    const cutoff = Date.now() - ACCRUAL_WINDOW_MS;
    const byOrigin = new Map<string, bigint>();
    for (const [origin, arr] of this.samples) {
      const fresh = arr.filter((s) => s.t >= cutoff);
      if (fresh.length === 0) {
        this.samples.delete(origin);
        continue;
      }
      this.samples.set(origin, fresh);
      // Sum over window, scale to per-minute. Window is 60s, so the raw sum ~= per-min.
      const sum = fresh.reduce((acc, s) => acc + s.base, 0n);
      byOrigin.set(origin, sum);
    }
    const selfPerMin = byOrigin.get(this.selfId) ?? 0n;
    // Append to the live sparkline ring (recompute runs every 5s; ~4 min of history).
    const history = [...this.state.selfCreditsPerMinHistory, selfPerMin].slice(-Store.RATE_RING);
    this.set({
      accrualByOrigin: byOrigin,
      selfCreditsPerMin: selfPerMin,
      selfCreditsPerMinHistory: history,
    });
  }

  // ---- derived helpers ----

  get selfNodeId(): string {
    return this.selfId;
  }

  /** Credits/min Amount for self, derived from the accrual ring. */
  selfCreditsPerMinAmount(): Amount {
    return Amount.fromBaseUnits(this.state.selfCreditsPerMin);
  }

  /** Best-effort credits/min for a given origin (host) as an Amount. */
  creditsPerMinFor(origin: string): Amount | null {
    const v = this.state.accrualByOrigin.get(origin);
    return v === undefined ? null : Amount.fromBaseUnits(v);
  }
}

function makeClient(baseUrl: string, token?: string): CeClient {
  return token !== undefined && token !== ""
    ? CeClient.withToken(baseUrl, token)
    : CeClient.withToken(baseUrl);
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
