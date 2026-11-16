// Cold Circle server entry point (Phase 0–1 vertical slice).
//
// One process: an HTTP/HTTPS server that also hosts a WebSocket server on the
// same port. HTTP handles GET /health and serves the single-file browser client;
// the WebSocket handles the JSON-line protocol (auth, public chat, presence,
// ping/pong). See the technical spec §3.
//
// Run:  npm run build && npm start
// Env:  COLD_CIRCLE_CONFIG=/path/to/config.yaml  (default ./coldcircle.config.yaml)

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, normalize } from "node:path";
import http from "node:http";
import https from "node:https";
import { WebSocketServer, WebSocket } from "ws";

import { loadConfig, type Config } from "./config.js";
import { authenticate, sanitizeHandle } from "./auth.js";
import { ChatEngine } from "./chat.js";
import { DMStore } from "./dmstore.js";
import { FileStore } from "./filestore.js";
import { BulletinStore } from "./bulletin.js";
import { newSessionId, SessionStore, type Session } from "./session.js";
import {
  OP,
  encode,
  type ChatMsg,
  type ClientFrame,
  type ChatMsgFrame,
  type ChatHistoryFrameOut,
  type ServerFrame,
  type UserJoinFrame,
  type UserLeaveFrame,
  type DMHistoryFrameOut,
  type DMPendingFrame,
  type FileEntryFrame,
  type FileListFrameOut,
  type FileDownloadFrameOut,
  type BulletinEntryFrame,
  type BulletinListFrameOut,
  type BulletinPost,
  // Admin frame types (Phase 5).
  type AdminServerInfoFrameOut,
  type AdminChannelListFrameOut,
  type AdminFileListFrameOut,
  type AdminDMAuditFrameOut,
  type AdminBannedListFrameOut,
  type DMStoredMsg,
} from "./protocol.js";

const VERSION = "0.1.0-slice01";
// Hard cap on a single chat body to stop trivially large frames.
const MAX_CHAT_BODY = 8192;

// --- Security hardening constants (Phase 4.5) ---
// Max payload per WebSocket frame (bytes). 1 MB for chat/DM.
const WS_MAX_PAYLOAD = 1_048_576;
// Per-connection rate limit: max frames per sliding window (minutes).
const MAX_FRAMES_PER_MINUTE = 120;
// Per-connection auth failure limit before closing.
const MAX_AUTH_FAILURES = 5;
// Maximum number of channels (including default).
const MAX_CHANNELS = 100;
// Channel name regex: letters, digits, #, dots, slashes, underscores, hyphens.
const CHANNEL_NAME_RE = /^[A-Za-z0-9#./_-]+$/;

// Per-connection rate-limiter state (Fix 2, 3, 7).
interface ConnLimits {
  frameTimes: number[];       // timestamps of recent frames
  authFailures: number;       // consecutive auth failures on this connection
}

class ColdCircleServer {
  private sockets = new Map<WebSocket, Session>(); // authenticated sockets only
  private sessions = new SessionStore();
  // Map of unauthenticated WebSocket -> rate-limit state (Fix 2, 3, 7).
  private connLimits = new Map<WebSocket, ConnLimits>();
  private chat: ChatEngine;
  private dmStore: DMStore;
  private fileStore: FileStore;
  private bulletin: BulletinStore;
  // Banned handles: rejected at auth time (Phase 5).
  private bannedHandles = new Set<string>();
  // Server start time (for uptime calculation).
  private readonly _startTime: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  // Fix 5: stale upload cleanup timer.
  private uploadCleanupTimer: NodeJS.Timeout | null = null;

  constructor(private cfg: Config) {
    this._startTime = Date.now();
    this.chat = new ChatEngine(cfg.chat);
    this.dmStore = new DMStore();
    this.fileStore = new FileStore(cfg.files);
    this.bulletin = new BulletinStore(cfg.bulletin);
  }

  async start(): Promise<void> {
    // Optional TLS. When certs are configured, serve https + wss; otherwise the
    // slice runs plain http + ws (fine for local dev, not for public exposure).
    let httpServer: http.Server;
    if (this.cfg.server.tls?.cert && this.cfg.server.tls?.key) {
      const cert = await readFile(this.cfg.server.tls.cert);
      const key = await readFile(this.cfg.server.tls.key);
      httpServer = https.createServer({ cert, key }, this.onHttpRequest.bind(this));
      console.log(`[cold-circle] TLS enabled (https + wss).`);
    } else {
      httpServer = http.createServer(this.onHttpRequest.bind(this));
      console.log(`[cold-circle] No TLS configured — running http + ws. Use TLS for public use.`);
    }

    // Fix 1: Set maxPayload on the WebSocketServer to prevent trivially large frames.
    const wss = new WebSocketServer({ server: httpServer, maxPayload: WS_MAX_PAYLOAD });
    wss.on("connection", (ws) => this.onConnection(ws));

    // Retention sweep per spec §3.4.1.
    const sweepMs = Math.max(1, this.cfg.chat.sweep_interval_sec) * 1000;
    this.sweepTimer = setInterval(() => {
      const dropped = this.chat.sweep();
      if (dropped > 0) console.log(`[cold-circle] retention sweep dropped ${dropped} message(s).`);
    }, sweepMs);
    // Don't keep the event loop alive for the sweep alone.
    this.sweepTimer.unref();

    // Fix 5: Periodic cleanup of stale (abandoned) file uploads.
    // Clean up uploads older than 1 hour every 5 minutes.
    const uploadSweepMs = 5 * 60 * 1000;
    this.uploadCleanupTimer = setInterval(() => {
      const now = Date.now();
      const stale = this.fileStore.cleanupStaleUploads(now);
      if (stale > 0) console.log(`[cold-circle] upload cleanup dropped ${stale} stale upload(s).`);
    }, uploadSweepMs);
    this.uploadCleanupTimer.unref();

    await new Promise<void>((resolve) => httpServer.listen(this.cfg.server.port, this.cfg.server.bind, resolve));
    const proto = this.cfg.server.tls ? "wss" : "ws";
    console.log(
      `[cold-circle] v${VERSION} listening on ${proto}://${this.cfg.server.bind}:${this.cfg.server.port}` +
        ` (client at http://${this.cfg.server.bind === "0.0.0.0" ? "127.0.0.1" : this.cfg.server.bind}:${this.cfg.server.port})`,
    );
  }

  // --- HTTP ------------------------------------------------------------------
  private onHttpRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = (req.url ?? "/").split("?")[0];

    if (url === "/health") {
      const body = JSON.stringify({
        status: "ok",
        version: VERSION,
        time: Date.now(),
        online: this.sessions.onlineHandles(),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }

    // Serve the browser client. Default document is index.html.
    this.serveStatic(url, res);
  };

  private serveStatic(urlPath: string, res: http.ServerResponse): void {
    const publicDir = join(process.cwd(), "public");
    // Map "/" to index.html; everything else is a path under public/.
    const rel = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");
    const filePath = normalize(join(publicDir, rel));
    // Path-traversal guard: resolved path must stay inside publicDir.
    if (!filePath.startsWith(normalize(publicDir)) || !existsSync(filePath)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(filePath);
    } catch {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (!st.isFile()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const type = contentType(filePath);
    const cacheHeader = filePath.endsWith(".html") ? "no-store" : "no-cache";
    res.writeHead(200, { "content-type": type, "cache-control": cacheHeader });
    createReadStream(filePath).pipe(res);
  }

  // --- WebSocket -------------------------------------------------------------
  private onConnection(ws: WebSocket): void {
    // Initialize connection limits for this socket (Fix 2, 3, 7).
    this.connLimits.set(ws, { frameTimes: [], authFailures: 0 });

    ws.on("message", (raw) => this.onMessage(ws, raw));
    ws.on("close", () => this.onClose(ws));
    ws.on("error", () => {
      // The close handler does the cleanup; nothing actionable to log here.
    });
  }

  // Fix 3: Check per-connection rate limit. Returns true if the frame is allowed.
  private checkRateLimit(ws: WebSocket): boolean {
    const limits = this.connLimits.get(ws);
    if (!limits) return true;

    const now = Date.now();
    // Remove frame timestamps older than 1 minute.
    limits.frameTimes = limits.frameTimes.filter((t) => now - t < 60_000);

    if (limits.frameTimes.length >= MAX_FRAMES_PER_MINUTE) {
      this.send(ws, { op: OP.ERROR, code: "rate_limited", message: "too many requests" });
      ws.close();
      return false;
    }

    limits.frameTimes.push(now);
    return true;
  }

  // Fix 2: Track auth failures per connection.
  private recordAuthFailure(ws: WebSocket): void {
    const limits = this.connLimits.get(ws);
    if (!limits) return;
    limits.authFailures++;
    if (limits.authFailures >= MAX_AUTH_FAILURES) {
      console.log(`[cold-circle] closing connection after ${MAX_AUTH_FAILURES} auth failures.`);
      this.send(ws, { op: OP.ERROR, code: "auth_too_many", message: "too many failed auth attempts" });
      ws.close();
    }
  }

  private onMessage(ws: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]): void {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw.toString("utf8")) as ClientFrame;
    } catch {
      this.send(ws, { op: OP.ERROR, code: "bad_frame", message: "frame is not valid JSON" });
      ws.close();
      return;
    }
    if (!frame || typeof frame.op !== "string") {
      this.send(ws, { op: OP.ERROR, code: "bad_frame", message: "missing op" });
      ws.close();
      return;
    }

    // Only the first frame is `auth`; everything else needs a live session.
    if (frame.op === OP.AUTH) {
      this.handleAuth(ws, frame);
      return;
    }

    // Fix 3: Rate-limit check for authenticated frames.
    if (!this.checkRateLimit(ws)) return;

    const session = this.sessions.touch(frame.session as string | undefined);
    if (!session) {
      this.send(ws, { op: OP.ERROR, code: "unauthenticated", message: "missing or expired session" });
      ws.close();
      return;
    }
    // The token in the frame must be the one issued to this socket.
    if (this.sockets.get(ws)?.id !== session.id) {
      this.send(ws, { op: OP.ERROR, code: "unauthenticated", message: "session mismatch" });
      ws.close();
      return;
    }

    switch (frame.op) {
      case OP.CHAT_SEND:
        this.handleChatSend(ws, session, frame);
        break;
      case OP.CHAT_HISTORY:
        this.handleChatHistory(ws, session, frame);
        break;
      case OP.DM_SEND:
        this.handleDMSend(ws, session, frame);
        break;
      case OP.DM_HISTORY:
        this.handleDMHistory(ws, session, frame);
        break;
      case OP.FILE_UPLOAD:
        this.handleFileUpload(ws, session, frame);
        break;
      case OP.FILE_LIST:
        this.handleFileList(ws, session);
        break;
      case OP.FILE_DOWNLOAD:
        this.handleFileDownload(ws, session, frame);
        break;
      case OP.FILE_DELETE:
        this.handleFileDelete(ws, session, frame);
        break;
      case OP.BULLETIN_POST:
        this.handleBulletinPost(ws, session, frame);
        break;
      case OP.BULLETIN_LIST:
        this.handleBulletinList(ws, session, frame);
        break;
      case OP.PING:
        this.send(ws, { op: OP.PONG, ts: Date.now() });
        break;
      // --- Admin handlers (Phase 5) ---
      case OP.ADMIN_SERVER_INFO:
        this.handleAdminServerInfo(ws, session);
        break;
      case OP.ADMIN_CHANNEL_LIST:
        this.handleAdminChannelList(ws, session);
        break;
      case OP.ADMIN_CHANNEL_CREATE:
        this.handleAdminChannelCreate(ws, session, frame);
        break;
      case OP.ADMIN_CHANNEL_DELETE:
        this.handleAdminChannelDelete(ws, session, frame);
        break;
      case OP.ADMIN_CHANNEL_SET_RETENTION:
        this.handleAdminChannelSetRetention(ws, session, frame);
        break;
      case OP.ADMIN_FILE_LIST:
        this.handleAdminFileList(ws, session);
        break;
      case OP.ADMIN_DM_AUDIT:
        this.handleAdminDMAudit(ws, session, frame);
        break;
      case OP.ADMIN_BULLETIN_LIST:
        this.handleAdminBulletinListClient(ws, session);
        break;
      case OP.ADMIN_BULLETIN_DELETE:
        this.handleAdminBulletinDelete(ws, session, frame);
        break;
      case OP.ADMIN_BAN:
        this.handleAdminBan(ws, session, frame);
        break;
      case OP.ADMIN_UNBAN:
        this.handleAdminUnban(ws, session, frame);
        break;
      case OP.ADMIN_BANNED_LIST:
        this.handleAdminBannedList(ws, session);
        break;
      default:
        this.send(ws, { op: OP.ERROR, code: "unknown_op", message: `unknown op: ${frame.op}` });
    }
  }

  // --- Admin handlers (Phase 5) ---

  /** Ensure the session is admin; returns true if so. */
  private requireAdmin(ws: WebSocket, session: Session): boolean {
    if (session.role !== "admin") {
      this.send(ws, { op: OP.ERROR, code: "admin_only", message: "admin role required" });
      return false;
    }
    return true;
  }

  private handleAdminServerInfo(ws: WebSocket, session: Session): void {
    if (!this.requireAdmin(ws, session)) return;
    const out: AdminServerInfoFrameOut = {
      op: OP.ADMIN_SERVER_INFO,
      version: VERSION,
      uptime_ms: Date.now() - this._startTime,
      online_handles: this.sessions.onlineHandles(),
      online_count: this.sessions.size,
      channel_count: this.chat.listChannels().length,
      channels: this.chat.listChannels(),
      total_sessions: this.sockets.size,
      file_count: this.fileStore.list().filter((e) => !e.isDir).length,
      file_disk_usage: this.fileStore.diskUsage(),
      bulletin_count: this.bulletin.list().length,
      dm_conversations: this.dmStore.size,
    };
    this.send(ws, out);
  }

  private handleAdminChannelList(ws: WebSocket, session: Session): void {
    if (!this.requireAdmin(ws, session)) return;
    const channels = this.chat.listChannels().map((name): { name: string; message_count: number; retention_sec: number | null } => {
      const ch = this.chat["channels"] as Map<string, { messages: ChatMsg[]; retentionMs: number | null }>;
      const chData = ch.get(name);
      return {
        name,
        message_count: chData ? chData.messages.length : 0,
        retention_sec: chData?.retentionMs ?? null,
      };
    });
    const out: AdminChannelListFrameOut = { op: OP.ADMIN_CHANNEL_LIST, channels };
    this.send(ws, out);
  }

  private handleAdminChannelCreate(ws: WebSocket, session: Session, frame: ClientFrame): void {
    if (!this.requireAdmin(ws, session)) return;
    const name = typeof frame.channel === "string" ? frame.channel.trim() : "";
    if (!name) {
      this.send(ws, { op: OP.ERROR, code: "bad_channel", message: "missing channel name" });
      return;
    }
    if (!CHANNEL_NAME_RE.test(name)) {
      this.send(ws, { op: OP.ERROR, code: "invalid_channel", message: "channel name contains invalid characters" });
      return;
    }
    if (this.chat.hasChannel(name)) {
      this.send(ws, { op: OP.ERROR, code: "channel_exists", message: "channel already exists" });
      return;
    }
    // Admin bypasses the channel cap.
    this.chat.ensureChannel(name);
    console.log(`[cold-circle] admin created channel: ${name}`);
    const out: AdminChannelListFrameOut = { op: OP.ADMIN_CHANNEL_LIST, channels: this._channelList() };
    this.send(ws, out);
  }

  private handleAdminChannelDelete(ws: WebSocket, session: Session, frame: ClientFrame): void {
    if (!this.requireAdmin(ws, session)) return;
    const name = typeof frame.channel === "string" ? frame.channel.trim() : "";
    if (!name) {
      this.send(ws, { op: OP.ERROR, code: "bad_channel", message: "missing channel name" });
      return;
    }
    const ch = this.chat["channels"] as Map<string, unknown>;
    if (!ch.has(name)) {
      this.send(ws, { op: OP.ERROR, code: "channel_not_found", message: "channel does not exist" });
      return;
    }
    ch.delete(name);
    console.log(`[cold-circle] admin deleted channel: ${name}`);
    const out: AdminChannelListFrameOut = { op: OP.ADMIN_CHANNEL_LIST, channels: this._channelList() };
    this.send(ws, out);
  }

  private handleAdminChannelSetRetention(ws: WebSocket, session: Session, frame: ClientFrame): void {
    if (!this.requireAdmin(ws, session)) return;
    const name = typeof frame.channel === "string" ? frame.channel.trim() : "";
    const retentionSec = typeof frame.retention_sec === "number" ? frame.retention_sec : 0;
    if (!name) {
      this.send(ws, { op: OP.ERROR, code: "bad_channel", message: "missing channel name" });
      return;
    }
    if (!this.chat.hasChannel(name)) {
      this.send(ws, { op: OP.ERROR, code: "channel_not_found", message: "channel does not exist" });
      return;
    }
    this.chat.setRetention(name, retentionSec);
    console.log(`[cold-circle] admin set retention ${retentionSec}s on ${name}`);
    const out: AdminChannelListFrameOut = { op: OP.ADMIN_CHANNEL_LIST, channels: this._channelList() };
    this.send(ws, out);
  }

  private handleAdminFileList(ws: WebSocket, session: Session): void {
    if (!this.requireAdmin(ws, session)) return;
    const files = this.fileStore.adminListFiles();
    const out: AdminFileListFrameOut = { op: OP.ADMIN_FILE_LIST, files, disk_usage: this.fileStore.diskUsage() };
    this.send(ws, out);
  }

  private handleAdminDMAudit(ws: WebSocket, session: Session, frame: ClientFrame): void {
    if (!this.requireAdmin(ws, session)) return;
    const limit = typeof frame.limit === "number" && frame.limit > 0 ? Math.floor(frame.limit) : 500;
    const conversations = this.dmStore.listConvIds().map((convId): { convId: string; messages: DMStoredMsg[] } => {
      return { convId, messages: this.dmStore.history(convId, limit) };
    });
    const out: AdminDMAuditFrameOut = { op: OP.ADMIN_DM_AUDIT, conversations };
    this.send(ws, out);
  }

  private handleAdminBulletinDelete(ws: WebSocket, session: Session, frame: ClientFrame): void {
    if (!this.requireAdmin(ws, session)) return;
    const postId = typeof frame.post_id === "string" ? frame.post_id.trim() : "";
    if (!postId) {
      this.send(ws, { op: OP.ERROR, code: "bad_post_id", message: "missing post_id" });
      return;
    }
    const deleted = this.bulletin.delete(postId);
    if (!deleted) {
      this.send(ws, { op: OP.ERROR, code: "post_not_found", message: "bulletin post not found" });
      return;
    }
    console.log(`[cold-circle] admin deleted bulletin post: ${postId}`);
    // Broadcast the updated list to all clients.
    this.handleBulletinList(ws, session, { op: OP.BULLETIN_LIST, session: session.id } as ClientFrame);
  }

  private handleAdminBan(ws: WebSocket, session: Session, frame: ClientFrame): void {
    if (!this.requireAdmin(ws, session)) return;
    const target = typeof frame.handle === "string" ? frame.handle.trim() : "";
    if (!target) {
      this.send(ws, { op: OP.ERROR, code: "bad_handle", message: "missing handle" });
      return;
    }
    // Add to banned set.
    this.bannedHandles.add(target);
    // Disconnect all open sessions for this handle.
    const targets = this.socketsForHandle(target);
    for (const targetWs of targets) {
      this.send(targetWs, { op: OP.ERROR, code: "banned", message: "you have been banned" });
      targetWs.close();
    }
    console.log(`[cold-circle] admin banned: ${target} (${targets.length} session(s) disconnected).`);
    const out: AdminBannedListFrameOut = { op: OP.ADMIN_BANNED_LIST, handles: [...this.bannedHandles] };
    this.send(ws, out);
  }

  private handleAdminUnban(ws: WebSocket, session: Session, frame: ClientFrame): void {
    if (!this.requireAdmin(ws, session)) return;
    const target = typeof frame.handle === "string" ? frame.handle.trim() : "";
    if (!target) {
      this.send(ws, { op: OP.ERROR, code: "bad_handle", message: "missing handle" });
      return;
    }
    const wasBanned = this.bannedHandles.delete(target);
    if (!wasBanned) {
      this.send(ws, { op: OP.ERROR, code: "not_banned", message: "handle is not banned" });
      return;
    }
    console.log(`[cold-circle] admin unbanned: ${target}`);
    const out: AdminBannedListFrameOut = { op: OP.ADMIN_BANNED_LIST, handles: [...this.bannedHandles] };
    this.send(ws, out);
  }

  private handleAdminBannedList(ws: WebSocket, session: Session): void {
    if (!this.requireAdmin(ws, session)) return;
    const out: AdminBannedListFrameOut = { op: OP.ADMIN_BANNED_LIST, handles: [...this.bannedHandles] };
    this.send(ws, out);
  }

  // Admin bulletin list — returns bulletin posts with bulletin_id for admin deletion.
  private handleAdminBulletinListClient(ws: WebSocket, session: Session): void {
    if (!this.requireAdmin(ws, session)) return;
    const posts = this.bulletin.list().map((p): { bulletin_id: string; handle: string; ts: number; body: string } => {
      return { bulletin_id: p.id, handle: p.handle, ts: p.ts, body: p.body };
    });
    const out = { op: OP.ADMIN_BULLETIN_LIST, posts };
    this.send(ws, out);
  }

  // Channel list helper (reads the private channels map).
  private _channelList(): { name: string; message_count: number; retention_sec: number | null }[] {
    const ch = this.chat["channels"] as Map<string, { messages: ChatMsg[]; retentionMs: number | null }>;
    return [...ch.keys()].map((name): { name: string; message_count: number; retention_sec: number | null } => {
      const chData = ch.get(name);
      return {
        name,
        message_count: chData ? chData.messages.length : 0,
        retention_sec: chData?.retentionMs ?? null,
      };
    });
  }

  private handleAuth(ws: WebSocket, frame: ClientFrame): void {
    const handle = sanitizeHandle(frame.handle as string);
    if (!handle) {
      this.recordAuthFailure(ws);
      this.send(ws, { op: OP.AUTH_FAIL, reason: "invalid handle" });
      ws.close();
      return;
    }
    // Phase 5: Reject banned handles.
    if (this.bannedHandles.has(handle)) {
      console.log(`[cold-circle] banned handle rejected: ${handle}`);
      this.send(ws, { op: OP.AUTH_FAIL, reason: "handle is banned" });
      ws.close();
      return;
    }
    const result = authenticate(this.cfg, frame.passphrase as string);
    if (!result.ok || !result.role) {
      this.recordAuthFailure(ws);
      this.send(ws, { op: OP.AUTH_FAIL, reason: result.reason ?? "auth failed" });
      ws.close();
      return;
    }

    const firstTab = !this.sessions.onlineHandles().includes(handle);
    const session = this.sessions.add({ id: newSessionId(), handle, role: result.role });
    this.sockets.set(ws, session);

    if (firstTab) this.broadcast(this.userJoinFrame(handle));
    this.send(ws, { op: OP.AUTH_OK, session: session.id, role: session.role, handle: session.handle, retention_sec: this.cfg.chat.public_retention_sec });
    // Notify the user about any pending DMs (messages sent while they were offline).
    this.pushPendingDMs(ws, session.handle);
    console.log(`[cold-circle] ${handle} joined as ${session.role} (${this.sockets.size} session(s) open).`);
  }

  private handleChatSend(ws: WebSocket, session: Session, frame: ClientFrame): void {
    // Fix 7: Validate channel names.
    const channel =
      typeof frame.channel === "string" && frame.channel.trim()
        ? frame.channel.trim()
        : this.cfg.chat.default_channel;

    // Fix 8: Enforce per-server channel cap.
    if (!this.chat.hasChannel(channel)) {
      if (this.chat.listChannels().length >= MAX_CHANNELS) {
        this.send(ws, { op: OP.ERROR, code: "channel_cap_exceeded", message: `server at max channels (${MAX_CHANNELS})` });
        return;
      }
      if (!CHANNEL_NAME_RE.test(channel)) {
        this.send(ws, { op: OP.ERROR, code: "invalid_channel", message: "channel name contains invalid characters" });
        return;
      }
      // Auto-create the channel (it doesn't exist yet).
      this.chat.ensureChannel(channel);
    }
    const body = typeof frame.body === "string" ? frame.body : "";
    if (body.length === 0) return; // ignore empty sends
    const msg = this.chat.add(channel, session.handle, body.slice(0, MAX_CHAT_BODY));
    this.broadcast(this.chatMsgFrame(msg));
  }

  private handleChatHistory(ws: WebSocket, _session: Session, frame: ClientFrame): void {
    const channel =
      typeof frame.channel === "string" && frame.channel.trim()
        ? frame.channel.trim()
        : this.cfg.chat.default_channel;
    const limit = typeof frame.limit === "number" && frame.limit > 0 ? Math.floor(frame.limit) : 500;
    const out: ChatHistoryFrameOut = { op: OP.CHAT_HISTORY, channel, messages: this.chat.history(channel, limit) };
    this.send(ws, out);
  }

  // Relay a 1:1 direct message to every session of the target handle. The DM
  // is also persisted so the sender can retrieve history on reconnect (spec §3.4.2).
  private handleDMSend(ws: WebSocket, session: Session, frame: ClientFrame): void {
    const to = typeof frame.to === "string" ? frame.to.trim() : "";
    const body = typeof frame.body === "string" ? frame.body : "";
    if (!to || !body) {
      this.send(ws, { op: OP.ERROR, code: "bad_dm", message: "dm_send requires a non-empty to and body" });
      return;
    }
    // conv_id comes from the sender and is echoed to the recipient so both sides
    // group the same conversation; fall back to a generated one if omitted.
    const convId =
      typeof frame.conv_id === "string" && frame.conv_id
        ? frame.conv_id
        : "c_" + randomBytes(4).toString("hex");

    // Persist the DM (both directions: sender->recipient and recipient->sender).
    this.dmStore.add(session.handle, to, convId, body.slice(0, MAX_CHAT_BODY));

    const targets = this.socketsForHandle(to);
    if (targets.length === 0) {
      this.send(ws, { op: OP.DM_NORECIPIENT, to });
      return;
    }
    const msg = {
      op: OP.DM_RECV,
      from: session.handle,
      to,
      body: body.slice(0, MAX_CHAT_BODY),
      conv_id: convId,
      ts: Date.now(),
    };
    for (const target of targets) this.send(target, msg);
  }

  // Fix 4: Return stored DM history for a conversation ONLY if the requesting
  // user is a participant (from or to).
  private handleDMHistory(ws: WebSocket, session: Session, frame: ClientFrame): void {
    const convId = typeof frame.conv_id === "string" ? frame.conv_id.trim() : "";
    if (!convId) {
      this.send(ws, { op: OP.ERROR, code: "bad_dm_history", message: "dm_history requires a conv_id" });
      return;
    }
    const limit = typeof frame.limit === "number" && frame.limit > 0 ? Math.floor(frame.limit) : 500;
    const msgs = this.dmStore.history(convId, limit);

    // Access control: only return messages where the requesting user is a participant.
    const accessible = msgs.filter((m) => m.from === session.handle || m.to === session.handle);
    const out: DMHistoryFrameOut = { op: OP.DM_HISTORY, conv_id: convId, messages: accessible };
    this.send(ws, out);
  }

  // Handle a file upload: start, chunk, or finalize.
  private handleFileUpload(ws: WebSocket, session: Session, frame: ClientFrame): void {
    const action = typeof frame.action === "string" ? frame.action : "start";
    const uploadId = typeof frame.upload_id === "string" ? frame.upload_id : "";
    const name = typeof frame.name === "string" ? frame.name : "";
    const size = typeof frame.size === "number" ? frame.size : 0;

    if (action === "start") {
      const result = this.fileStore.startUpload(name, size, session.handle);
      if (typeof result === "string") {
        // Success: return the uploadId.
        this.send(ws, { op: OP.FILE_START_OK, upload_id: result, size: size });
      } else {
        this.send(ws, { op: OP.ERROR, code: "upload_failed", message: result.error });
      }
    } else if (action === "chunk") {
      let data: Buffer;
      if (Buffer.isBuffer(frame.data)) {
        data = frame.data;
      } else if (Array.isArray(frame.data)) {
        // Client sends numeric array from JSON frame; convert to Buffer.
        data = Buffer.from(frame.data as number[]);
      } else {
        data = Buffer.alloc(0);
      }
      if (!uploadId) {
        this.send(ws, { op: OP.ERROR, code: "bad_file_chunk", message: "missing upload_id" });
        return;
      }
      const err = this.fileStore.appendChunk(uploadId, data);
      if (err.error) {
        this.send(ws, { op: OP.ERROR, code: "upload_failed", message: err.error });
      }
    } else if (action === "finalize") {
      const err = this.fileStore.finalizeUpload(uploadId);
      if (err.error) {
        this.send(ws, { op: OP.ERROR, code: "upload_failed", message: err.error });
      } else {
        console.log(`[cold-circle] file uploaded by ${session.handle}: ${name}`);
      }
    }
  }

  // List files in the store.
  private handleFileList(ws: WebSocket, _session: Session): void {
    const entries = this.fileStore.list().map((e): FileEntryFrame => ({
      op: OP.FILE_ENTRY,
      name: e.name,
      size: e.size,
      modified: e.modified,
      isDir: e.isDir,
    }));
    const out: FileListFrameOut = {
      op: OP.FILE_LIST,
      entries,
      disk_usage: this.fileStore.diskUsage(),
    };
    this.send(ws, out);
  }

  // Handle a file download: read the file, encode as base64, send to client.
  private handleFileDownload(ws: WebSocket, _session: Session, frame: ClientFrame): void {
    const name = typeof frame.name === "string" ? frame.name : "";
    if (!name) {
      this.send(ws, { op: OP.ERROR, code: "bad_file_download", message: "missing file name" });
      return;
    }
    const resolved = this.fileStore.resolvePath(name);
    if (!resolved || !existsSync(resolved)) {
      this.send(ws, { op: OP.ERROR, code: "download_failed", message: "file not found" });
      return;
    }
    try {
      const buf = readFileSync(resolved);
      const out: FileDownloadFrameOut = {
        op: OP.FILE_DOWNLOAD,
        name: name,
        data: buf.toString("base64"),
      };
      this.send(ws, out);
    } catch {
      this.send(ws, { op: OP.ERROR, code: "download_failed", message: "could not read file" });
    }
  }

  // Fix 6: Handle a file delete request with ownership check.
  private handleFileDelete(ws: WebSocket, session: Session, frame: ClientFrame): void {
    const name = typeof frame.name === "string" ? frame.name : "";
    if (!name) {
      this.send(ws, { op: OP.ERROR, code: "bad_file_delete", message: "missing file name" });
      return;
    }
    // Ownership check: only the uploading user (or admin) can delete.
    const deleted = this.fileStore.delete(name, session.handle);
    if (!deleted) {
      this.send(ws, { op: OP.ERROR, code: "delete_failed", message: "file not found" });
      return;
    }
    console.log(`[cold-circle] file deleted by ${session.handle}: ${name}`);
    // Reload the file list to reflect the change.
    this.handleFileList(ws, session);
  }

  // Handle a bulletin post: append to the bulletin feed and broadcast to all.
  private handleBulletinPost(ws: WebSocket, session: Session, frame: ClientFrame): void {
    const body = typeof frame.body === "string" ? frame.body : "";
    if (!body) {
      this.send(ws, { op: OP.ERROR, code: "bad_bulletin_post", message: "missing body" });
      return;
    }
    const result = this.bulletin.post(session.handle, body);
    if (typeof result === "object" && "error" in result) {
      this.send(ws, { op: OP.ERROR, code: "post_failed", message: result.error });
      return;
    }
    console.log(`[cold-circle] bulletin post by ${session.handle}: ${result.body.slice(0, 60)}...`);
    // Broadcast to all connected clients.
    this.broadcast(this.bulletinPostFrame(result));
    // Acknowledge to the sender.
    this.send(ws, this.bulletinPostFrame(result));
  }

  // Handle a bulletin list request: return all posts to the requester.
  private handleBulletinList(ws: WebSocket, _session: Session, frame: ClientFrame): void {
    const limit = typeof frame.limit === "number" && frame.limit > 0 ? Math.floor(frame.limit) : 500;
    const entries = this.bulletin.list(limit).map((p): BulletinEntryFrame => ({
      op: OP.BULLETIN_ENTRY,
      id: p.id,
      handle: p.handle,
      ts: p.ts,
      body: p.body,
    }));
    const out: BulletinListFrameOut = {
      op: OP.BULLETIN_LIST,
      entries,
    };
    this.send(ws, out);
  }

  // All authenticated sockets whose session belongs to `handle`. A handle may
  // have several open tabs, so a DM relays to every one of them.
  private socketsForHandle(handle: string): WebSocket[] {
    const out: WebSocket[] = [];
    for (const [socket, s] of this.sockets) if (s.handle === handle) out.push(socket);
    return out;
  }

  private onClose(ws: WebSocket): void {
    // Clean up connection limits.
    this.connLimits.delete(ws);

    const session = this.sockets.get(ws);
    if (!session) return;
    this.sockets.delete(ws);
    this.sessions.remove(session);
    if (!this.sessions.onlineHandles().includes(session.handle)) {
      this.broadcast(this.userLeaveFrame(session.handle));
    }
    console.log(`[cold-circle] ${session.handle} left (${this.sockets.size} session(s) open).`);
  }

  // Push conv_ids where `handle` is a recipient of any stored DM.
  // The client should respond with dm_history for each conv_id.
  private pushPendingDMs(ws: WebSocket, handle: string): void {
    const convIds = this.dmStore.convIdsForRecipient(handle);
    if (convIds.length === 0) return;
    const out: DMPendingFrame = { op: OP.DM_PENDING, conv_ids: convIds };
    this.send(ws, out);
    console.log(`[cold-circle] ${handle} has ${convIds.length} pending DM conversation(s).`);
  }

  // --- Broadcasting ----------------------------------------------------------
  private broadcast(frame: ServerFrame): void {
    const line = encode(frame);
    for (const ws of this.sockets.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(line);
    }
  }

  private userJoinFrame(handle: string): UserJoinFrame {
    return { op: OP.USER_JOIN, handle, ts: Date.now() };
  }
  private userLeaveFrame(handle: string): UserLeaveFrame {
    return { op: OP.USER_LEAVE, handle, ts: Date.now() };
  }
  private chatMsgFrame(m: ChatMsg): ChatMsgFrame {
    return { op: OP.CHAT_MSG, id: m.id, channel: m.channel, handle: m.handle, ts: m.ts, body: m.body };
  }
  private bulletinPostFrame(p: BulletinPost): BulletinEntryFrame {
    return { op: OP.BULLETIN_ENTRY, id: p.id, handle: p.handle, ts: p.ts, body: p.body };
  }

  // Send one frame to a single socket, guarding against writes after close.
  private send(target: WebSocket, frame: ServerFrame): void {
    if (target.readyState === WebSocket.OPEN) target.send(encode(frame));
  }
}

function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
      return "text/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

async function main(): Promise<void> {
  const configPath = process.env.COLD_CIRCLE_CONFIG ?? "./coldcircle.config.yaml";
  let cfg: Config;
  try {
    cfg = await loadConfig(configPath);
  } catch (err) {
    console.error(`[cold-circle] ${String((err as Error).message)}`);
    process.exit(1);
  }
  const server = new ColdCircleServer(cfg);
  await server.start();
}

main();
