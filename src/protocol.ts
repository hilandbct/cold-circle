// Wire protocol for Cold Circle. All WebSocket traffic after the handshake is
// JSON-line: exactly one JSON object per frame. This file holds the op names and
// the message shapes used by the Phase 0–2 slice (skeleton, public chat, DMs).
//
// See the technical spec §3.2 (transport) and §5 (protocol summary).

export type Role = "user" | "admin";

// A public chat message. `channel` is echoed on every frame so a client that is
// listening on multiple channels can route it without state.
export interface ChatMsg {
  id: string;
  channel: string;
  handle: string;
  ts: number; // epoch milliseconds
  body: string;
}

// --- Client -> Server ---------------------------------------------------------
export interface AuthFrame {
  op: "auth";
  passphrase: string;
  handle: string;
}
export interface ChatSendFrame {
  op: "chat_send";
  channel: string;
  body: string;
  session?: string;
}
export interface ChatHistoryFrame {
  op: "chat_history";
  channel: string;
  limit?: number;
  session?: string;
}
// A 1:1 direct message. `conv_id` groups a conversation on both sides; the
// sender generates it and the server echoes it to the recipient.
export interface DMSendFrame {
  op: "dm_send";
  to: string;
  body: string;
  conv_id?: string;
  session?: string;
}
// Request DM history for a specific conversation.
export interface DMHistoryFrame {
  op: "dm_history";
  conv_id: string;
  limit?: number;
  session?: string;
}
export interface PingFrame {
  op: "ping";
  session?: string;
}
// Inbound frames are parsed from untrusted JSON, so at runtime we treat a frame
// as a loose record and validate field-by-field instead of trusting a strict
// shape. The specific interfaces above document each op's expected payload.
export interface ClientFrame {
  op: string;
  [field: string]: unknown;
}

// --- Server -> Client ---------------------------------------------------------
export interface AuthOkFrame {
  op: "auth_ok";
  session: string;
  role: Role;
  // The canonical (sanitized) handle the server accepted, echoed so the client
  // knows its own identity after trimming/normalization.
  handle: string;
  // Default public-channel retention window, so the client can render its
  // "window: N min" indicator. Per-channel overrides aren't surfaced yet.
  retention_sec: number;
}
export interface AuthFailFrame {
  op: "auth_fail";
  reason: string;
}
export interface ChatMsgFrame {
  op: "chat_msg";
  id: string;
  channel?: string;
  handle: string;
  ts: number;
  body: string;
}
export interface ChatHistoryFrameOut {
  op: "chat_history";
  channel: string;
  // Newest first, per spec §3.4.1. The client reverses for bottom-anchored display.
  messages: ChatMsg[];
}
export interface UserJoinFrame {
  op: "user_join";
  handle: string;
  ts: number;
}
export interface UserLeaveFrame {
  op: "user_leave";
  handle: string;
  ts: number;
}
// Delivered to the recipient of a DM. `conv_id` is the sender's, echoed so both
// parties group the same conversation.
export interface DMRecvFrame {
  op: "dm_recv";
  from: string;
  to: string;
  body: string;
  conv_id: string;
  ts: number;
}
// Sent to the sender when the target handle has no open session.
export interface DMNoRecipientFrame {
  op: "dm_norecipient";
  to: string;
}
// Sent to a newly-connected user listing conv_ids where they have pending DMs.
export interface DMPendingFrame {
  op: "dm_pending";
  conv_ids: string[];
}
// Sent in response to a dm_history request — messages oldest-first.
export interface DMHistoryFrameOut {
  op: "dm_history";
  conv_id: string;
  // Oldest first, so the client can append chronologically.
  messages: DMStoredMsg[];
}
export interface PongFrame {
  op: "pong";
  ts: number;
}
export interface ErrorFrame {
  op: "error";
  code: string;
  message: string;
}
// A stored DM message (persisted by the server, spec §3.4.2).
export interface DMStoredMsg {
  from: string;
  to: string;
  body: string;
  conv_id: string;
  ts: number;
}
// A bulletin board post.
export interface BulletinPost {
  id: string;
  handle: string;
  ts: number;
  body: string;
}
// Client sends a bulletin post.
export interface BulletinPostFrame {
  op: "bulletin_post";
  body: string;
  session?: string;
}
// Client requests the bulletin list.
export interface BulletinListFrame {
  op: "bulletin_list";
  limit?: number;
  session?: string;
}
// A single bulletin entry returned to the client.
export interface BulletinEntryFrame {
  op: "bulletin_entry";
  id: string;
  handle: string;
  ts: number;
  body: string;
}
// Response: bulletin list (one frame per entry, then a marker).
export interface BulletinListFrameOut {
  op: "bulletin_list";
  entries: BulletinEntryFrame[];
}
// File upload request from client.
export interface FileUploadFrame {
  op: "file_upload";
  name: string;
  size: number;
  upload_id: string;
  session?: string;
}
// File list request from client.
export interface FileListFrame {
  op: "file_list";
  session?: string;
}
// A file entry returned to the client.
export interface FileEntryFrame {
  op: "file_entry";
  name: string;
  size: number;
  modified: number;
  isDir: boolean;
}
// Request from client to download a file.
export interface FileDownloadFrame {
  op: "file_download";
  name: string;
  session?: string;
}
// Request from client to delete a file.
export interface FileDeleteFrame {
  op: "file_delete";
  name: string;
  session?: string;
}
// Response: one frame with the file name, then binary chunks.
export interface FileDownloadFrameOut {
  op: "file_download";
  name: string;
  data: string; // base64-encoded file content
}
// File list response (one frame per entry, then a marker).
export interface FileListFrameOut {
  op: "file_list";
  entries: FileEntryFrame[];
  disk_usage: number;
}
// Response to a file_upload(start) — confirms the upload ID.
export interface FileStartOkFrame {
  op: "file_start_ok";
  upload_id: string;
  size: number;
}
// --- Admin protocol types (Phase 5) -----------------------------------------
// Admin channel management.
export interface AdminChannelCreateFrame {
  op: "admin_channel_create";
  channel: string;
  session?: string;
}
export interface AdminChannelDeleteFrame {
  op: "admin_channel_delete";
  channel: string;
  session?: string;
}
export interface AdminChannelSetRetentionFrame {
  op: "admin_channel_set_retention";
  channel: string;
  retention_sec: number;
  session?: string;
}
// Admin server info.
export interface AdminServerInfoFrame {
  op: "admin_server_info";
  session?: string;
}
// Response: server info (one frame).
export interface AdminServerInfoFrameOut {
  op: "admin_server_info";
  version: string;
  uptime_ms: number;
  online_handles: string[];
  online_count: number;
  channel_count: number;
  channels: string[];
  total_sessions: number;
  file_count: number;
  file_disk_usage: number;
  bulletin_count: number;
  dm_conversations: number;
}
// Admin channel list response.
export interface AdminChannelListFrameOut {
  op: "admin_channel_list";
  channels: { name: string; message_count: number; retention_sec: number | null }[];
}
// Admin file list with uploader info.
export interface AdminFileListFrameOut {
  op: "admin_file_list";
  files: { name: string; size: number; uploader: string; modified: number; isDir: boolean }[];
  disk_usage: number;
}
// Admin DM audit — return all DM conversations.
export interface AdminDMAuditFrame {
  op: "admin_dm_audit";
  session?: string;
}
export interface AdminDMAuditFrameOut {
  op: "admin_dm_audit";
  conversations: { convId: string; messages: DMStoredMsg[] }[];
}
// Admin bulletin moderation.
export interface AdminBulletinDeleteFrame {
  op: "admin_bulletin_delete";
  post_id: string;
  session?: string;
}
// Admin user ban/unban.
export interface AdminBanFrame {
  op: "admin_ban";
  handle: string;
  session?: string;
}
export interface AdminUnbanFrame {
  op: "admin_unban";
  handle: string;
  session?: string;
}
export interface AdminBannedListFrameOut {
  op: "admin_banned_list";
  handles: string[];
}
// Admin bulletin list response (with bulletin_id for deletion).
export interface AdminBulletinListFrameOut {
  op: "admin_bulletin_list";
  posts: { bulletin_id: string; handle: string; ts: number; body: string }[];
}
export type ServerFrame =
  | AuthOkFrame
  | AuthFailFrame
  | ChatMsgFrame
  | ChatHistoryFrameOut
  | UserJoinFrame
  | UserLeaveFrame
  | DMRecvFrame
  | DMNoRecipientFrame
  | DMPendingFrame
  | DMHistoryFrameOut
  | PongFrame
  | ErrorFrame
  | FileStartOkFrame
  | FileListFrameOut
  | FileDownloadFrameOut
  | BulletinEntryFrame
  | BulletinListFrameOut
  // Admin frames (Phase 5).
  | AdminServerInfoFrameOut
  | AdminChannelListFrameOut
  | AdminFileListFrameOut
  | AdminDMAuditFrameOut
  | AdminBannedListFrameOut
  | AdminBulletinListFrameOut;

// Op constants so neither side hard-codes magic strings.
export const OP = {
  AUTH: "auth",
  AUTH_OK: "auth_ok",
  AUTH_FAIL: "auth_fail",
  CHAT_SEND: "chat_send",
  CHAT_MSG: "chat_msg",
  CHAT_HISTORY: "chat_history",
  USER_JOIN: "user_join",
  USER_LEAVE: "user_leave",
  DM_SEND: "dm_send",
  DM_RECV: "dm_recv",
  DM_NORECIPIENT: "dm_norecipient",
  DM_PENDING: "dm_pending",
  DM_HISTORY: "dm_history",
  FILE_UPLOAD: "file_upload",
  FILE_START_OK: "file_start_ok",
  FILE_LIST: "file_list",
  FILE_ENTRY: "file_entry",
  FILE_DOWNLOAD: "file_download",
  FILE_DELETE: "file_delete",
  BULLETIN_POST: "bulletin_post",
  BULLETIN_LIST: "bulletin_list",
  BULLETIN_ENTRY: "bulletin_entry",
  PING: "ping",
  PONG: "pong",
  ERROR: "error",
  // Admin ops (Phase 5).
  ADMIN_SERVER_INFO: "admin_server_info",
  ADMIN_CHANNEL_LIST: "admin_channel_list",
  ADMIN_CHANNEL_CREATE: "admin_channel_create",
  ADMIN_CHANNEL_DELETE: "admin_channel_delete",
  ADMIN_CHANNEL_SET_RETENTION: "admin_channel_set_retention",
  ADMIN_FILE_LIST: "admin_file_list",
  ADMIN_DM_AUDIT: "admin_dm_audit",
  ADMIN_BULLETIN_DELETE: "admin_bulletin_delete",
  ADMIN_BULLETIN_LIST: "admin_bulletin_list",
  ADMIN_BAN: "admin_ban",
  ADMIN_UNBAN: "admin_unban",
  ADMIN_BANNED_LIST: "admin_banned_list",
} as const;

// Serialize a frame to a single JSON line.
export function encode(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
