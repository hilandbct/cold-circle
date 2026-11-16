// Direct-message store: in-memory storage with per-conversation history.
// Each DM is keyed by (from, to, conv_id) and sorted by timestamp.
// See spec §3.4.2 — the server now *stores* DMs instead of discarding them.

import { DMStoredMsg } from "./protocol.js";

interface Conversation {
  convId: string;
  // Messages sorted oldest-first.
  messages: DMStoredMsg[];
}

export class DMStore {
  // Map convId -> conversation.  A conversation is created on the first DM
  // between two handles (with the same conv_id).
  private byConvId = new Map<string, Conversation>();

  // Add a DM message.  Creates the conversation if it doesn't exist yet.
  add(from: string, to: string, convId: string, body: string): DMStoredMsg {
    let conv = this.byConvId.get(convId);
    if (!conv) {
      conv = { convId, messages: [] };
      this.byConvId.set(convId, conv);
    }
    const msg: DMStoredMsg = {
      from,
      to,
      body,
      conv_id: convId,
      ts: Date.now(),
    };
    conv.messages.push(msg);
    return msg;
  }

  // Return stored messages for a conversation, oldest-first, capped by limit.
  history(convId: string, limit = 500): DMStoredMsg[] {
    const conv = this.byConvId.get(convId);
    if (!conv) return [];
    let msgs = conv.messages;
    if (limit > 0 && limit < msgs.length) {
      msgs = msgs.slice(msgs.length - limit);
    }
    return msgs.slice(); // return a copy
  }

  // Return all known conv_ids (useful for listing conversations).
  listConvIds(): string[] {
    return [...this.byConvId.keys()];
  }

  // Return conv_ids where the given handle is a recipient of any message.
  // This lets the server notify a newly-connected user about pending DMs.
  convIdsForRecipient(handle: string): string[] {
    const out = new Set<string>();
    for (const conv of this.byConvId.values()) {
      for (const m of conv.messages) {
        if (m.to === handle) {
          out.add(conv.convId);
          break;
        }
      }
    }
    return [...out];
  }

  // Drop a conversation (admin-only, not yet exposed).
  drop(convId: string): boolean {
    return this.byConvId.delete(convId);
  }

  get size(): number {
    return this.byConvId.size;
  }
}