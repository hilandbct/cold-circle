// Passphrase authentication. A client authenticates with either the shared
// passphrase (-> role "user") or the admin passphrase (-> role "admin").
// Comparisons are constant-time to avoid timing oracles. See spec §3.3.

import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { Role } from "./protocol.js";

function constantTimeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, so guard it explicitly.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface AuthResult {
  ok: boolean;
  role?: Role;
  reason?: string;
}

export function authenticate(cfg: Config, passphrase: string): AuthResult {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    return { ok: false, reason: "missing passphrase" };
  }
  // Check admin first so a client that happens to know only the admin secret
  // still authenticates as admin.
  if (constantTimeEq(passphrase, cfg.server.admin_passphrase)) {
    return { ok: true, role: "admin" };
  }
  if (constantTimeEq(passphrase, cfg.server.passphrase)) {
    return { ok: true, role: "user" };
  }
  return { ok: false, reason: "invalid passphrase" };
}

// Handle validation: non-empty, sane length, and no characters that could
// break log lines or client rendering assumptions.
export function sanitizeHandle(handle: string): string | undefined {
  if (typeof handle !== "string") return undefined;
  const trimmed = handle.trim();
  if (trimmed.length < 1 || trimmed.length > 32) return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return undefined;
  return trimmed;
}
