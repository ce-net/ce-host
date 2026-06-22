import { describe, it, expect, beforeEach } from "vitest";
import { Amount } from "@ce-net/sdk";
import { Store } from "../src/stores/store.js";

/**
 * The store calls a handful of CeClient methods. We swap `store.client` for a fake that
 * returns canned data, then invoke the private refresh methods directly (they are the
 * "reducers" that fold node responses into StoreState). No network, no timers.
 */
function fakeClient(overrides: Record<string, unknown> = {}) {
  const status = {
    nodeId: "node-self",
    height: 100,
    difficulty: 1,
    balance: Amount.fromCredits("12.5"),
    circulatingSupply: Amount.fromCredits("1000"),
    burnedTotal: Amount.ZERO,
    bond: Amount.ZERO,
    weight: 1,
    free: Amount.fromCredits("12"),
    lockedChannels: Amount.fromCredits("0.5"),
    lockedBond: Amount.ZERO,
  };
  return {
    health: async () => true,
    getStatus: async () => status,
    history: async () => ({
      nodeId: "node-self",
      jobsHosted: 5,
      jobsPaid: 2,
      heartbeatsHosted: 0,
      heartbeatsPaid: 0,
      expiries: 0,
      earned: Amount.fromCredits("10"),
      spent: Amount.fromCredits("4"),
      firstHeight: 0,
      lastHeight: 100,
      isNewcomer: () => false,
      deliveredWork: () => 5,
    }),
    listJobs: async () => [
      { jobId: "j1", status: "running" },
      { jobId: "j2", status: "settled" },
    ],
    atlas: async () => [{ nodeId: "peer-a", cpuCores: 8, memMb: 16384 }],
    wallet: {
      balance: async () => ({
        total: Amount.fromCredits("12.5"),
        free: Amount.fromCredits("12"),
        lockedChannels: Amount.fromCredits("0.5"),
        lockedBond: Amount.ZERO,
        bond: Amount.ZERO,
      }),
      listChannels: async () => [],
      transactions: async () => [
        {
          txId: "tx1",
          height: 99,
          kind: "UptimeReward",
          amount: Amount.fromCredits("1"),
          counterparty: null,
          direction: "in",
        },
      ],
      transfer: async () => "tx-xfer",
    },
    capabilities: { revoked: async () => [] },
    ...overrides,
  };
}

describe("Store refresh reducers", () => {
  let store: Store;

  beforeEach(() => {
    localStorage.clear();
    store = new Store();
    // Replace the real client before any refresh runs.
    (store as unknown as { client: unknown }).client = fakeClient();
  });

  async function refresh(name: string): Promise<void> {
    await (store as unknown as Record<string, () => Promise<void>>)[name]!();
  }

  it("starts in 'connecting' health", () => {
    expect(store.state.health).toBe("connecting");
  });

  it("refreshStatus marks online and folds status + self history", async () => {
    await refresh("refreshStatus");
    expect(store.state.health).toBe("online");
    expect(store.state.status?.nodeId).toBe("node-self");
    expect(store.state.status?.height).toBe(100);
    expect(store.selfNodeId).toBe("node-self");
    expect(store.state.selfHistory?.jobsHosted).toBe(5);
    expect(store.state.error).toBeNull();
  });

  it("refreshStatus goes offline when health is false", async () => {
    (store as unknown as { client: unknown }).client = fakeClient({
      health: async () => false,
    });
    await refresh("refreshStatus");
    expect(store.state.health).toBe("offline");
  });

  it("refreshJobs records jobs and tracks first-seen for running jobs", async () => {
    await refresh("refreshJobs");
    expect(store.state.jobs).toHaveLength(2);
    expect(store.state.firstSeen["j1"]).toBeGreaterThan(0);
    expect(store.state.firstSeen["j2"]).toBeUndefined();
  });

  it("refreshJobs clears 'removing' flags for jobs that vanished", async () => {
    store.state.removing = new Set(["gone", "j1"]);
    await refresh("refreshJobs");
    // 'gone' is not in the returned job list → dropped; 'j1' stays.
    expect(store.state.removing.has("gone")).toBe(false);
    expect(store.state.removing.has("j1")).toBe(true);
  });

  it("refreshWallet folds balance, channels, and tx history", async () => {
    // Wallet history needs selfId; populate it via a status refresh first.
    await refresh("refreshStatus");
    await refresh("refreshWallet");
    expect(store.state.balance?.total.toCredits()).toBe("12.5");
    expect(store.state.channels).toEqual([]);
    expect(store.state.txHistory).toHaveLength(1);
    expect(store.state.historyAvailable).toBe(true);
  });

  it("refreshWallet degrades gracefully when /transactions 404s on old nodes", async () => {
    const c = fakeClient();
    c.wallet.transactions = async () => {
      throw new Error("CeApiError: HTTP 404 not found");
    };
    (store as unknown as { client: unknown }).client = c;
    await refresh("refreshStatus");
    await refresh("refreshWallet");
    expect(store.state.historyAvailable).toBe(false);
  });

  it("subscribers are notified when state changes", async () => {
    let hits = 0;
    const unsub = store.subscribe(() => hits++);
    await refresh("refreshStatus");
    expect(hits).toBeGreaterThan(0);
    unsub();
  });
});
