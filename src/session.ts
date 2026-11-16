// Session store. The server is stateless per client except for the active
// session token -> connection map and a presence view of connected handles.
// See spec §3.3 (auth) and §3.4 (chat/DM). This slice tracks sessions and the
// presence needed for user_join / user_leave.

import { randomBytes } from "node:crypto";
import type { Role } from "./protocol.js";

// A live browser connection.
export interface Session {
  id: string; // 256-bit random token, hex
  handle: string;
  role: Role;
  expiry: number; // epoch ms; refreshed on every valid frame (sliding)
}

// The token lifetime. Refreshed on each authenticated frame.
const TOKEN_TTL_MS = 10 * 60 * 1000;

export function newSessionId(): string {
  return randomBytes(32).toString("hex");
}

export class SessionStore {
  private byToken = new Map<string, Session>();
  // A handle may have several open tabs; presence counts distinct sessions.
  private byHandle = new Map<string, Set<Session>>();

  add(session: Omit<Session, "expiry">): Session {
    const full: Session = { ...session, expiry: Date.now() + TOKEN_TTL_MS };
    this.byToken.set(full.id, full);
    let set = this.byHandle.get(full.handle);
    if (!set) {
      set = new Set();
      this.byHandle.set(full.handle, set);
    }
    // true if this session is the first tab for this handle.
    set.add(full);
    return full;
  }

  // Returns the session, refreshing its sliding expiry. Undefined if unknown/expired.
  touch(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.byToken.get(id);
    if (!s) return undefined;
    if (s.expiry <= Date.now()) {
      this.remove(s);
      return undefined;
    }
    s.expiry = Date.now() + TOKEN_TTL_MS;
    return s;
  }

  // Drop a session from the store. Returns the session that was removed, if any.
  remove(session: Session): Session | undefined {
    if (!this.byToken.has(session.id)) return undefined;
    this.byToken.delete(session.id);
    const set = this.byHandle.get(session.handle);
    if (set) {
      set.delete(session);
      if (set.size === 0) this.byHandle.delete(session.handle);
    }
    return session;
  }

  // Distinct handles currently online (one entry per connected user, not per tab).
  onlineHandles(): string[] {
    return [...this.byHandle.keys()];
  }

  get size(): number {
    return this.byToken.size;
  }
}
