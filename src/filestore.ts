// File store: manages file uploads/downloads on disk with path traversal
// protection, extension filtering, and size limits. See spec 3.5.
//
// Files are stored under a configurable root directory. Clients upload files
// by name into a logical directory tree, and the server maps them to the
// physical root. Only files whose extensions are in the allow list (or "*"
// for all) are accepted.

import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, truncateSync, unlinkSync, appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { FilesConfig } from "./config.js";

// A single file entry as returned to the client.
export interface FileEntry {
  name: string;        // file name (not full path)
  size: number;        // bytes
  modified: number;    // epoch ms (last modified time)
  isDir: boolean;      // true for directory entries
}

// Internal state for in-progress uploads.
interface InProgressUpload {
  filePath: string;
  expectedSize: number;
  handle: string;
  createdAt: number;    // epoch ms — for stale upload cleanup (Fix 5)
}

// Metadata for finalized files — tracks who uploaded for ownership check (Fix 6).
interface FileMeta {
  name: string;
  uploader: string;
}

export class FileStore {
  private root: string;
  private maxUploadBytes: number;
  private allowExtensions: string[];
  private uploads = new Map<string, InProgressUpload>();
  // Track uploader per file name for ownership-based delete (Fix 6).
  private fileMeta = new Map<string, FileMeta>();

  constructor(cfg: FilesConfig) {
    this.root = normalize(cfg.root);
    this.maxUploadBytes = Math.max(1, cfg.max_upload_bytes);
    this.allowExtensions = cfg.allow_extensions.map((ext) => ext.toLowerCase());
    // Ensure the root directory exists.
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
    }
  }

  // List files in the root directory. Returns entries sorted alphabetically,
  // directories first.
  list(): FileEntry[] {
    if (!existsSync(this.root)) return [];
    const entries: FileEntry[] = [];
    for (const name of readdirSync(this.root).sort()) {
      const fullPath = join(this.root, name);
      try {
        const st = statSync(fullPath);
        entries.push({
          name,
          size: st.isDirectory() ? 0 : st.size,
          modified: st.mtimeMs,
          isDir: st.isDirectory(),
        });
      } catch {
        // Skip unreadable entries.
      }
    }
    return entries;
  }

  // Start a file upload. Returns a unique upload ID that the client uses
  // to stream chunks. Returns an error if the file is rejected.
  startUpload(clientName: string, fileSize: number, handle: string): string | { error: string } {
    // Validate file size.
    if (fileSize > this.maxUploadBytes) {
      return { error: "file exceeds max size (" + this.maxUploadBytes + " bytes)" };
    }
    // Sanitize the client-provided name: strip path components, keep only the leaf.
    const safeName = this.sanitizeName(clientName);
    if (!safeName) {
      return { error: "invalid file name" };
    }
    // Validate extension.
    const ext = this.extensionOf(safeName);
    if (ext && !this.allowExtensions.includes("*") && !this.allowExtensions.includes("." + ext.toLowerCase())) {
      return { error: "extension ." + ext + " not allowed" };
    }
    // Determine the physical path.
    const filePath = join(this.root, safeName);
    // Path-traversal guard: resolved path must stay inside root.
    if (!filePath.startsWith(this.root)) {
      return { error: "path traversal detected" };
    }
    // Create the file (truncate).
    try {
      writeFile(filePath, Buffer.alloc(0)).catch(() => {});
    } catch {
      return { error: "could not create file" };
    }
    const uploadId = "upload_" + Math.random().toString(36).slice(2, 10);
    this.uploads.set(uploadId, { filePath, expectedSize: fileSize, handle, createdAt: Date.now() });
    return uploadId;
  }

  // Append a chunk of data to an in-progress upload.
  appendChunk(uploadId: string, chunk: Buffer): { error?: string } {
    const upload = this.uploads.get(uploadId);
    if (!upload) {
      return { error: "unknown upload" };
    }
    try {
      appendFileSync(upload.filePath, chunk);
    } catch {
      return { error: "write failed" };
    }
    return {};
  }

  // Finalize an upload. Truncates or pads to the expected size.
  finalizeUpload(uploadId: string): { error?: string } {
    const upload = this.uploads.get(uploadId);
    if (!upload) {
      return { error: "unknown upload" };
    }
    try {
      const st = statSync(upload.filePath);
      if (st.size > upload.expectedSize) {
        truncateSync(upload.filePath, upload.expectedSize);
      } else if (st.size < upload.expectedSize) {
        // Pad with zeros.
        const pad = Buffer.alloc(upload.expectedSize - st.size, 0);
        appendFileSync(upload.filePath, pad);
      }
    } catch {
      // Ignore — file may not exist yet.
    }
    // Record ownership (Fix 6).
    this.fileMeta.set(normalize(upload.filePath), { name: upload.filePath, uploader: upload.handle });
    this.uploads.delete(uploadId);
    return {};
  }

  // Start a file download. Returns a ReadStream.
  download(name: string): { stream: ReturnType<typeof createReadStream> } | { error: string } {
    const resolved = this.resolvePath(name);
    if (!resolved || !existsSync(resolved) || statSync(resolved).isDirectory()) {
      return { error: "file not found" };
    }
    return { stream: createReadStream(resolved) };
  }

  // Fix 6: Delete a file. Only succeeds if the requesting user is the uploader
  // (or the file doesn't exist yet, meaning no ownership was recorded).
  delete(name: string, requestingHandle: string): boolean {
    const resolved = this.resolvePath(name);
    if (!resolved || !existsSync(resolved)) return false;

    // If there's ownership metadata, check the requesting user.
    const meta = this.fileMeta.get(normalize(resolved));
    if (meta && meta.uploader !== requestingHandle) {
      return false; // Not the uploader — deny.
    }

    try {
      unlinkSync(resolved);
      this.fileMeta.delete(normalize(resolved));
      return true;
    } catch {
      return false;
    }
  }

  // Get file metadata (size, modified time).
  metadata(name: string): FileEntry | null {
    const resolved = this.resolvePath(name);
    if (!resolved || !existsSync(resolved)) return null;
    const st = statSync(resolved);
    return { name, size: st.size, modified: st.mtimeMs, isDir: false };
  }

  // Get total disk usage of the file store.
  diskUsage(): number {
    let total = 0;
    const walk = (dir: string): void => {
      try {
        for (const entry of readdirSync(dir)) {
          const fullPath = join(dir, entry);
          const st = statSync(fullPath);
          if (st.isDirectory()) {
            walk(fullPath);
          } else {
            total += st.size;
          }
        }
      } catch {
        // Directory doesn't exist yet.
      }
    };
    walk(this.root);
    return total;
  }

  // Fix 5: Clean up stale (abandoned) uploads older than `cutoffMs` milliseconds.
  // Returns the number of uploads removed.
  cleanupStaleUploads(cutoffMs: number): number {
    const now = Date.now();
    let removed = 0;
    for (const [uploadId, upload] of this.uploads) {
      if (now - upload.createdAt > cutoffMs) {
        try {
          unlinkSync(upload.filePath);
        } catch {
          /* file may have been finalized already */
        }
        this.uploads.delete(uploadId);
        removed++;
      }
    }
    return removed;
  }

  // Resolve a file name to its physical path (returns null if invalid).
  public resolvePath(name: string): string | null {
    const safeName = this.sanitizeName(name);
    if (!safeName) return null;
    const resolved = normalize(join(this.root, safeName));
    if (!resolved.startsWith(normalize(this.root))) return null;
    return resolved;
  }

  private sanitizeName(name: string): string {
    // Strip any path components, keep only the leaf name.
    const parts = name.split(/[/\\]/);
    const leaf = parts[parts.length - 1].trim();
    if (!leaf || leaf.startsWith(".") || leaf.includes("..")) return "";
    // Only allow safe characters.
    if (!/^[A-Za-z0-9._-]+$/.test(leaf)) return "";
    return leaf;
  }

  private extensionOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot === -1 ? "" : name.slice(dot + 1);
  }

  // Admin file list: returns files with uploader info (from fileMeta).
  adminListFiles(): { name: string; size: number; uploader: string; modified: number; isDir: boolean }[] {
    const entries = this.list();
    return entries.map((e): { name: string; size: number; uploader: string; modified: number; isDir: boolean } => {
      const resolved = this.resolvePath(e.name);
      const meta = resolved ? this.fileMeta.get(normalize(resolved)) : undefined;
      return {
        name: e.name,
        size: e.size,
        uploader: meta ? meta.uploader : "unknown",
        modified: e.modified,
        isDir: e.isDir,
      };
    });
  }
}
