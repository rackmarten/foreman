import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinboardWatchdog, httpProbe, loadState, ntfyNotifier, watchdogConfig } from "./pinboard-watchdog.js";

const INTERVAL = 30_000;
const OUTAGE = 10 * 60_000;

// A stubbed pinboard: `up` decides what both endpoints answer.
function stubPinboard(): { fetch: typeof fetch; up: boolean; calls: string[] } {
  const stub = {
    up: true,
    calls: [] as string[],
    fetch: (async (url: string | URL | Request) => {
      stub.calls.push(String(url));
      return new Response("", { status: stub.up ? 200 : 502 });
    }) as typeof fetch,
  };
  return stub;
}

describe("PinboardWatchdog", () => {
  let dir: string;
  let statePath: string;
  let pinboard: ReturnType<typeof stubPinboard>;
  let alerts: string[];
  let repairs: number;
  let logs: string[];

  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-13T12:00:00Z") });
    dir = mkdtempSync(join(tmpdir(), "watchdog-"));
    statePath = join(dir, "state.json");
    pinboard = stubPinboard();
    alerts = [];
    repairs = 0;
    logs = [];
  });

  afterEach(() => {
    mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  function watchdog(): PinboardWatchdog {
    return new PinboardWatchdog(
      { intervalMs: INTERVAL, outageMs: OUTAGE, maxRunsPerDay: 2, statePath },
      {
        probe: httpProbe("http://pinboard.test", 1000, pinboard.fetch),
        notify: async (title, message) => {
          alerts.push(`${title}: ${message}`);
        },
        repair: () => {
          repairs++;
        },
        now: Date.now,
        log: (m) => logs.push(m),
      },
    );
  }

  // One probe per interval for `ms`, advancing the fake clock.
  async function runFor(w: PinboardWatchdog, ms: number): Promise<void> {
    for (let t = 0; t < ms; t += INTERVAL) {
      await w.tick();
      mock.timers.tick(INTERVAL);
    }
    await new Promise((r) => setImmediate(r));
  }

  it("probes both /health and /api/plan", async () => {
    await watchdog().tick();
    assert.deepEqual(pinboard.calls.sort(), ["http://pinboard.test/api/plan", "http://pinboard.test/health"]);
  });

  it("does not alert before the outage threshold", async () => {
    const w = watchdog();
    pinboard.up = false;
    await runFor(w, OUTAGE - INTERVAL);
    assert.deepEqual(alerts, []);
    assert.equal(repairs, 0);
    assert.ok(w.snapshot.failingSince);
  });

  it("restarts the timer when a probe succeeds in between", async () => {
    const w = watchdog();
    pinboard.up = false;
    await runFor(w, 8 * 60_000);
    pinboard.up = true;
    await runFor(w, INTERVAL);
    pinboard.up = false;
    await runFor(w, 8 * 60_000);
    assert.deepEqual(alerts, []);
    assert.equal(repairs, 0);
    assert.equal(w.snapshot.pending.length, 0);
  });

  it("alerts once and calls the repair hook once per outage", async () => {
    const w = watchdog();
    pinboard.up = false;
    await runFor(w, OUTAGE + 20 * 60_000);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /^pinboard is down: .*10 min.*repair run is starting/);
    assert.equal(repairs, 1);
    assert.ok(logs.includes("pinboard-watchdog: repair would start"));
  });

  it("allows at most two repair runs per 24h, across restarts", async () => {
    for (let i = 0; i < 3; i++) {
      // a fresh instance each time reads the bounds from the state file
      const w = watchdog();
      pinboard.up = false;
      await runFor(w, OUTAGE + INTERVAL);
      pinboard.up = true;
      await runFor(w, INTERVAL);
    }
    assert.equal(repairs, 2);
    assert.equal(alerts.filter((a) => a.startsWith("pinboard is down")).length, 3);
    assert.match(alerts.at(-2)!, /No repair run: 2 already ran/);
    assert.deepEqual(
      loadState(statePath).pending.map((p) => p.repair),
      ["started", "started", "bounded"],
    );

    // a day later the oldest runs have aged out
    mock.timers.tick(24 * 60 * 60_000);
    const w = watchdog();
    pinboard.up = false;
    await runFor(w, OUTAGE + INTERVAL);
    assert.equal(repairs, 3);
  });

  it("keeps an outage in progress across a restart", async () => {
    pinboard.up = false;
    await runFor(watchdog(), 6 * 60_000);
    await runFor(watchdog(), 5 * 60_000);
    assert.equal(alerts.length, 1);
    assert.equal(repairs, 1);
  });

  it("reports the recovery and keeps a pending record", async () => {
    const w = watchdog();
    pinboard.up = false;
    await runFor(w, 15 * 60_000);
    pinboard.up = true;
    await runFor(w, INTERVAL);
    assert.equal(alerts.at(-1), "pinboard is back: pinboard is back after 15 min.");
    const state = loadState(statePath);
    assert.equal(state.failingSince, null);
    assert.equal(state.pending.length, 1);
    assert.equal(state.pending[0].minutes, 15);
    assert.equal(state.pending[0].repair, "started");
    assert.match(state.pending[0].lastError ?? "", /answered 502/);
  });

  it("retries the outage alert when ntfy fails", async () => {
    let fail = true;
    const w = new PinboardWatchdog(
      { intervalMs: INTERVAL, outageMs: OUTAGE, maxRunsPerDay: 2, statePath },
      {
        probe: async () => "down",
        notify: async (title) => {
          if (fail) throw new Error("ntfy down");
          alerts.push(title);
        },
        repair: () => {
          repairs++;
        },
        now: Date.now,
        log: () => {},
      },
    );
    await runFor(w, OUTAGE + INTERVAL);
    fail = false;
    await runFor(w, 2 * INTERVAL);
    assert.deepEqual(alerts, ["pinboard is down"]);
    assert.equal(repairs, 1);
  });
});

describe("ntfyNotifier", () => {
  it("posts to the topic with a bearer token", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await ntfyNotifier({ url: "http://ntfy.test", topic: "pinboard", token: "tk" }, () => {}, fetchStub)("t", "m", 5);
    assert.equal(seen[0].url, "http://ntfy.test/pinboard");
    assert.equal(seen[0].init.method, "POST");
    assert.equal((seen[0].init.headers as Record<string, string>).Authorization, "Bearer tk");
    assert.equal(seen[0].init.body, "m");
  });

  it("only logs without ntfy config", async () => {
    const logs: string[] = [];
    await ntfyNotifier(null, (m) => logs.push(m))("pinboard is down", "x");
    assert.match(logs[0], /no ntfy configured.*pinboard is down/);
  });
});

describe("watchdogConfig", () => {
  it("reads the token from the variable it is told to", () => {
    const c = watchdogConfig({ NTFY_URL: "http://n/", PINBOARD_WATCHDOG_NTFY_TOKEN_VAR: "MY_TOKEN", MY_TOKEN: "x" }, "/h");
    assert.deepEqual(c.ntfy, { url: "http://n", topic: "pinboard", token: "x" });
    assert.equal(c.intervalMs, 30_000);
    assert.equal(c.outageMs, 600_000);
    assert.equal(c.statePath, "/h/.foreman/pinboard-watchdog.json");
  });

  it("has no ntfy without a token", () => {
    assert.equal(watchdogConfig({ NTFY_URL: "http://n" }, "/h").ntfy, null);
  });
});
