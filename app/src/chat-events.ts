// batching in front of pinboard's POST /chat/threads/:id/events.
//
// A live session emits text one delta at a time - a single paragraph is
// dozens of them - and each one is a few characters. POSTing per delta would
// put hundreds of round-trips on the tailnet per turn and hand pinboard a
// row per token to trim, for no gain the operator can see: the PWA renders
// them as they land, and landing four times a second reads as live.
//
// Two flush triggers, deliberately: a short timer (so a quiet stream still
// shows up promptly) and a size threshold (so a fast stream doesn't sit
// buffering a whole response because the timer hasn't fired yet).
//
// No SDK types here on purpose - this takes plain events and a `send`
// function, so its whole behaviour is testable without a Claude process.

import type { ChatEventInput, ChatEventKind } from "./pinboard.js";

export interface PendingChatEvent {
  kind: ChatEventKind;
  payload: Record<string, unknown>;
  turn?: number;
}

export type TimerHandle = unknown;

export interface ChatEventBatcherOptions {
  // Expected to resolve even on failure (pinboard.ts's postChatEvents
  // swallows its own errors) - anything that does throw is caught here
  // anyway, since a dropped progress event must never surface as an
  // unhandled rejection in a live session.
  send: (events: ChatEventInput[]) => Promise<unknown>;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxTextChars?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export const DEFAULT_FLUSH_INTERVAL_MS = 250;
export const DEFAULT_MAX_BATCH_SIZE = 50;
export const DEFAULT_MAX_TEXT_CHARS = 4000;

// The streaming kinds worth merging: consecutive deltas of the same kind in
// the same turn are one payload as far as any reader is concerned.
const MERGEABLE: ReadonlySet<ChatEventKind> = new Set<ChatEventKind>(["text_delta", "thinking"]);

export class ChatEventBatcher {
  private readonly opts: Required<Omit<ChatEventBatcherOptions, "send">> & Pick<ChatEventBatcherOptions, "send">;
  private buffer: ChatEventInput[] = [];
  private bufferedTextChars = 0;
  private timer: TimerHandle | null = null;
  private seq = 0;
  // Flushes are chained rather than run concurrently: two in-flight POSTs can
  // arrive out of order, and an event stream whose order is not the order it
  // happened in is worse than one that is a beat late.
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: ChatEventBatcherOptions) {
    this.opts = {
      send: options.send,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxTextChars: options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)),
    };
  }

  get pending(): number {
    return this.buffer.length;
  }

  add(event: PendingChatEvent): void {
    if (this.closed) return;
    const text = typeof event.payload.text === "string" ? event.payload.text : null;
    const last = this.buffer.at(-1);
    const mergeable =
      last !== undefined &&
      MERGEABLE.has(event.kind) &&
      last.kind === event.kind &&
      last.turn === event.turn &&
      text !== null &&
      typeof (last.payload as Record<string, unknown>).text === "string";

    if (mergeable && last) {
      const payload = last.payload as Record<string, unknown>;
      payload.text = `${String(payload.text)}${text}`;
    } else {
      this.seq += 1;
      this.buffer.push({ kind: event.kind, payload: { ...event.payload }, turn: event.turn, seq: this.seq });
    }
    if (text !== null) this.bufferedTextChars += text.length;

    if (this.buffer.length >= this.opts.maxBatchSize || this.bufferedTextChars >= this.opts.maxTextChars) {
      void this.flush();
      return;
    }
    this.schedule();
  }

  /** Send whatever is buffered now, and wait for it (and anything queued
   *  ahead of it) to land. */
  flush(): Promise<void> {
    this.cancelTimer();
    if (this.buffer.length === 0) return this.tail;
    const batch = this.buffer;
    this.buffer = [];
    this.bufferedTextChars = 0;
    this.tail = this.tail.then(async () => {
      try {
        await this.opts.send(batch);
      } catch {
        // See the `send` comment above: a lost progress event is not worth
        // taking a live session down for.
      }
    });
    return this.tail;
  }

  /** Flush and stop accepting events - a closed batcher silently drops adds
   *  so a late SDK message racing teardown can't resurrect the timer. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    this.cancelTimer();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = this.opts.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.flushIntervalMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.opts.clearTimer(this.timer);
    this.timer = null;
  }
}
