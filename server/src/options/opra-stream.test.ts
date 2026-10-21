import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, encode } from "@msgpack/msgpack";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OptionBar } from "./store.js";

let tmpDir: string;
let mod: typeof import("./opra-stream.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-opra-stream-test-"));
  process.env.DATA_DIR = tmpDir;
  mod = await import("./opra-stream.js");
});

afterAll(async () => {
  const { db } = await import("../db.js");
  const { minuteDb } = await import("../history/store.js");
  db.close();
  minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

class FakeSocket {
  binaryType = "blob";
  sent: any[] = [];
  closed = false;
  private handlers = new Map<string, Array<(ev: any) => void>>();
  send(data: Uint8Array | string) {
    this.sent.push(decode(data as Uint8Array));
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, fn: (ev: any) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  emit(type: string, ev: any = {}) {
    for (const fn of this.handlers.get(type) ?? []) fn(ev);
  }
  frame(msgs: unknown[]) {
    const bytes = encode(msgs);
    this.emit("message", { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}

const OPEN = Date.parse("2026-10-21T15:00:00Z"); // 11:00 New York, Wednesday
const CALL = "AAA261120C00100000";
const PUT = "AAA261120P00100000";

describe("inStreamWindow", () => {
  it("covers weekdays 09:25–16:05 New York", () => {
    expect(mod.inStreamWindow(Date.parse("2026-10-21T13:24:00Z"))).toBe(false); // 09:24
    expect(mod.inStreamWindow(Date.parse("2026-10-21T13:25:00Z"))).toBe(true);
    expect(mod.inStreamWindow(Date.parse("2026-10-21T20:04:00Z"))).toBe(true); // 16:04
    expect(mod.inStreamWindow(Date.parse("2026-10-21T20:05:00Z"))).toBe(false);
    expect(mod.inStreamWindow(Date.parse("2026-10-24T15:00:00Z"))).toBe(false); // Saturday
  });
});

describe("opra stream", () => {
  let clock = OPEN;
  let socket: FakeSocket;
  let opened: string[];
  let written: OptionBar[][];
  let stream: ReturnType<typeof mod.createOpraStream>;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ALPACA_API_KEY_ID = "kid";
    process.env.ALPACA_API_SECRET_KEY = "sec";
    clock = OPEN;
    opened = [];
    written = [];
    stream = mod.createOpraStream({
      spot: () => 100,
      now: () => clock,
      writeBars: (b) => written.push(b),
      openSocket: (url) => {
        opened.push(url);
        socket = new FakeSocket();
        return socket;
      },
    });
  });
  afterEach(() => {
    stream.stop();
    vi.useRealTimers();
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
    delete process.env.OPTIONS_STREAM;
  });

  const authenticate = () => {
    socket.frame([{ T: "success", msg: "connected" }]);
    socket.frame([{ T: "success", msg: "authenticated" }]);
  };

  it("connects, authenticates in msgpack, then subscribes quotes and trades", () => {
    stream.setTargets([CALL, PUT]);
    stream.start();
    expect(opened).toEqual(["wss://stream.data.alpaca.markets/v1beta1/opra"]);
    expect(socket.binaryType).toBe("arraybuffer");
    socket.frame([{ T: "success", msg: "connected" }]);
    expect(socket.sent[0]).toEqual({ action: "auth", key: "kid", secret: "sec" });
    socket.frame([{ T: "success", msg: "authenticated" }]);
    expect(socket.sent[1]).toEqual({ action: "subscribe", quotes: [CALL, PUT], trades: [CALL, PUT] });
    expect(stream.status()).toMatchObject({ connected: true, subscribed: 2, lastError: null });
  });

  it("sends only the difference when the targets change", () => {
    stream.start();
    authenticate();
    stream.setTargets([CALL, PUT]);
    stream.setTargets([CALL, "BBB261120C00050000"]);
    expect(socket.sent.slice(1)).toEqual([
      { action: "subscribe", quotes: [CALL, PUT], trades: [CALL, PUT] },
      { action: "subscribe", quotes: ["BBB261120C00050000"], trades: ["BBB261120C00050000"] },
      { action: "unsubscribe", quotes: [PUT], trades: [PUT] },
    ]);
    expect(stream.status().subscribed).toBe(2);
  });

  it("decodes quotes, computes IV and delta, throttles to one a second", () => {
    stream.setTargets([CALL]);
    stream.start();
    authenticate();
    socket.frame([{ T: "q", S: CALL, bp: 3.9, ap: 4.1, bs: 10, as: 12, t: "2026-10-21T15:00:00Z" }]);
    const q = stream.quote(CALL)!;
    expect(q).toMatchObject({ bid: 3.9, ask: 4.1, bidSize: 10 });
    expect(q.iv).toBeGreaterThan(0.05);
    expect(q.delta).toBeGreaterThan(0.3);
    const iv = q.iv;
    clock += 200;
    socket.frame([{ T: "q", S: CALL, bp: 5, ap: 5.2, bs: 1, as: 1 }]);
    expect(stream.quote(CALL)!.ask).toBe(5.2);
    expect(stream.quote(CALL)!.iv).toBe(iv); // within a second: not recomputed
    clock += 1_000;
    socket.frame([{ T: "q", S: CALL, bp: 5, ap: 5.2, bs: 1, as: 1 }]);
    expect(stream.quote(CALL)!.iv).toBeGreaterThan(iv!);
  });

  it("accumulates trades and writes one bar per contract per minute", () => {
    stream.start();
    authenticate();
    socket.frame([{ T: "q", S: CALL, bp: 3.9, ap: 4.1, bs: 1, as: 1 }, { T: "t", S: CALL, p: 4.0, s: 3 }, { T: "t", S: CALL, p: 4.05, s: 2 }]);
    stream.flush();
    expect(written).toHaveLength(1);
    expect(written[0][0]).toMatchObject({ occ: CALL, bid: 3.9, ask: 4.1, mid: 4, last: 4.05, volume: 5 });
    expect(written[0][0].ts).toBe(Math.floor(OPEN / 60_000) * 60);
    stream.flush();
    expect(written).toHaveLength(1); // nothing new
  });

  it("reconnects with backoff while in the window, and resubscribes", () => {
    stream.setTargets([CALL]);
    stream.start();
    authenticate();
    socket.emit("close");
    expect(stream.status().connected).toBe(false);
    vi.advanceTimersByTime(999);
    expect(opened).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(opened).toHaveLength(2);
    authenticate();
    expect(socket.sent[1]).toEqual({ action: "subscribe", quotes: [CALL], trades: [CALL] });
    // Closing before authenticating doubles the delay each time.
    socket.emit("close");
    vi.advanceTimersByTime(1_001);
    expect(opened).toHaveLength(3);
    socket.emit("close");
    vi.advanceTimersByTime(1_500);
    expect(opened).toHaveLength(3);
    vi.advanceTimersByTime(600);
    expect(opened).toHaveLength(4);
  });

  it("does not reconnect when Alpaca refuses the account", () => {
    stream.start();
    socket.frame([{ T: "error", code: 402, msg: "auth failed" }]);
    socket.emit("close");
    vi.advanceTimersByTime(120_000);
    expect(opened).toHaveLength(1);
    expect(stream.status()).toMatchObject({ refused: true, lastError: "stream error 402: auth failed" });
  });

  it("stays disconnected outside the window and with OPTIONS_STREAM=0", () => {
    clock = Date.parse("2026-10-21T22:00:00Z"); // 18:00 New York
    stream.start();
    expect(opened).toHaveLength(0);
    clock = OPEN;
    vi.advanceTimersByTime(30_000);
    expect(opened).toHaveLength(1);
    clock = Date.parse("2026-10-21T21:00:00Z"); // 17:00
    vi.advanceTimersByTime(30_000);
    expect(socket.closed).toBe(true);
    stream.stop();
    process.env.OPTIONS_STREAM = "0";
    const off = mod.createOpraStream({ spot: () => 100, now: () => OPEN, openSocket: () => new FakeSocket() });
    off.start();
    expect(off.status().enabled).toBe(false);
  });
});
