// Public chat engine: an in-memory ring buffer per channel with a retention
// timer. No database — state lives in memory and is dropped when the server
// stops. See spec §3.4.1 and §3.1 (chat:).

import { randomBytes } from "node:crypto";
import type { ChatConfig } from "./config.js";
import { ChatMsg } from "./protocol.js";

interface Channel {
  messages: ChatMsg[];
  // Retention in ms; null means "keep forever within the buffer cap".
  retentionMs: number | null;
}

export class ChatEngine {
  private channels = new Map<string, Channel>();
  private readonly cap: number;

  constructor(cfg: ChatConfig) {
    this.cap = Math.max(1, Math.floor(cfg.max_buffer_messages));
    // The default channel exists from the start, with its configured retention.
    this.channels.set(cfg.default_channel, {
      messages: [],
      retentionMs: cfg.public_retention_sec <= 0 ? null : cfg.public_retention_sec * 1000,
    });
  }

  // Get-or-create a channel. A newly created channel defaults to no retention
  // (kept within the buffer cap); retention is set explicitly via setRetention.
  // Made public for channel management (Fix 8: channel cap enforcement).
  ensureChannel(name: string): Channel {
    let ch = this.channels.get(name);
    if (!ch) {
      ch = { messages: [], retentionMs: null };
      this.channels.set(name, ch);
    }
    return ch;
  }

  listChannels(): string[] {
    return [...this.channels.keys()];
  }

  hasChannel(name: string): boolean {
    return this.channels.has(name);
  }

  // Append a message to a channel's ring buffer and return it. Drops the oldest
  // entry when the cap is exceeded.
  add(channel: string, handle: string, body: string): ChatMsg {
    const ch = this.ensureChannel(channel);
    const msg: ChatMsg = {
      id: "m_" + randomBytes(4).toString("hex"),
      channel,
      handle,
      ts: Date.now(),
      body,
    };
    ch.messages.push(msg);
    if (ch.messages.length > this.cap) ch.messages.shift();
    return msg;
  }

  // Return the retention window for a channel, newest first, capped by `limit`.
  // Mirrors the chat_history reply in spec §3.4.1.
  history(channel: string, limit = 500): ChatMsg[] {
    const ch = this.channels.get(channel);
    if (!ch) return [];
    let msgs = ch.messages;
    if (ch.retentionMs !== null) {
      const cutoff = Date.now() - ch.retentionMs;
      msgs = msgs.filter((m) => m.ts >= cutoff);
    }
    if (limit >= 0 && limit < msgs.length) msgs = msgs.slice(msgs.length - limit);
    // Newest first.
    return msgs.slice().reverse();
  }

  // Purge expired messages from every channel. Driven by a setInterval sweep in
  // the server. Returns the number of messages dropped.
  sweep(): number {
    let dropped = 0;
    for (const ch of this.channels.values()) {
      if (ch.retentionMs === null) continue;
      const cutoff = Date.now() - ch.retentionMs;
      const kept = ch.messages.filter((m) => m.ts >= cutoff);
      dropped += ch.messages.length - kept.length;
      ch.messages = kept;
    }
    return dropped;
  }

  // Override the retention window for a channel (admin op, spec §3.8).
  setRetention(channel: string, retentionSec: number): boolean {
    const ch = this.ensureChannel(channel);
    ch.retentionMs = retentionSec <= 0 ? null : retentionSec * 1000;
    this.sweepChannel(ch);
    return true;
  }

  private sweepChannel(ch: Channel): void {
    if (ch.retentionMs === null) return;
    const cutoff = Date.now() - ch.retentionMs;
    ch.messages = ch.messages.filter((m) => m.ts >= cutoff);
  }
}
