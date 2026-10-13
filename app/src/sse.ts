// a minimal Server-Sent Events line parser, for the outbound
// subscription foreman holds open against pinboard's GET /chat/stream (see
// pinboard.ts's subscribeChatStream).
//
// Hand-written rather than pulling in an EventSource polyfill, for the same
// reason permission-server.ts hand-rolled its JSON-RPC framing: this repo
// has exactly one consumer of it, global `fetch` already gives a
// ReadableStream to decode, and the format is a handful of rules. Those
// rules are followed as the WHATWG spec states them rather than as "split on
// \n\n", because every one of the awkward cases is real over a long-lived
// HTTP connection: a heartbeat comment line, a multi-line `data:` payload,
// and above all an event split across TCP chunk boundaries - a 4KB read can
// land anywhere, including between the \r and the \n of one terminator.

export interface SseEvent {
  /** `event:` field, or "message" when the producer sent none. */
  event: string;
  /** `data:` field(s), multiple lines joined with "\n". */
  data: string;
  /** `id:` field, if the producer sent one (pinboard currently does not). */
  id?: string;
}

const TERMINATOR = /\r\n|\n|\r/;

export class SseParser {
  private buffer = "";
  // True when the last thing consumed was a bare "\r" at the very end of a
  // chunk: the next chunk may open with the "\n" that completes it, and that
  // "\n" must be swallowed rather than read as an extra (event-dispatching)
  // blank line.
  private pendingCR = false;

  private eventName = "";
  private dataLines: string[] = [];
  private lastId: string | undefined;

  /** Feed one decoded chunk; returns whatever complete events it completed. */
  push(chunk: string): SseEvent[] {
    let text = chunk;
    if (this.pendingCR && text.startsWith("\n")) text = text.slice(1);
    this.pendingCR = false;
    this.buffer += text;

    const events: SseEvent[] = [];
    for (;;) {
      const match = TERMINATOR.exec(this.buffer);
      if (!match) break;
      const line = this.buffer.slice(0, match.index);
      const terminator = match[0];
      const atEnd = match.index + terminator.length === this.buffer.length;
      this.buffer = this.buffer.slice(match.index + terminator.length);
      // The line itself is complete either way - only the question of whether
      // a following "\n" belongs to this terminator is still open.
      if (terminator === "\r" && atEnd) this.pendingCR = true;
      const event = this.consumeLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  private consumeLine(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    // ": ping" and friends - a heartbeat exists to keep the connection warm
    // and carries nothing, so it must not dispatch or disturb a half-built
    // event.
    if (line.startsWith(":")) return null;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") this.eventName = value;
    else if (field === "data") this.dataLines.push(value);
    else if (field === "id") this.lastId = value;
    // `retry` (and anything unknown) is ignored: reconnect backoff here is
    // chat-daemon.ts's, not the producer's to set.
    return null;
  }

  private dispatch(): SseEvent | null {
    if (this.dataLines.length === 0) {
      // A blank line with no data buffered is not an event - per spec it just
      // resets the event name.
      this.eventName = "";
      return null;
    }
    const event: SseEvent = {
      event: this.eventName || "message",
      data: this.dataLines.join("\n"),
      ...(this.lastId === undefined ? {} : { id: this.lastId }),
    };
    this.eventName = "";
    this.dataLines = [];
    return event;
  }
}
