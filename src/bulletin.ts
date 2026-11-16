// Bulletin board: an in-memory message feed with a configurable cap.
// No persistence — posts live in memory and are dropped when the server
// restarts. See spec §3.4.3 (bulletin board).
//
// Unlike chat (per-channel), the bulletin is a single global feed.
// Any authenticated user can post; posts are visible to all.

import { randomBytes } from "node:crypto";
import type { BulletinConfig } from "./config.js";
import { BulletinPost } from "./protocol.js";

export class BulletinStore {
  private posts: BulletinPost[];
  private readonly maxPosts: number;
  private readonly maxPostBytes: number;

  constructor(cfg: BulletinConfig) {
    this.maxPosts = Math.max(1, cfg.max_posts);
    this.maxPostBytes = Math.max(1, cfg.max_post_bytes);
    this.posts = [];
  }

  // Post a message to the bulletin board. Returns the post or an error.
  post(handle: string, body: string): BulletinPost | { error: string } {
    if (body.length > this.maxPostBytes) {
      return { error: "post exceeds max size (" + this.maxPostBytes + " bytes)" };
    }
    const post: BulletinPost = {
      id: "b_" + randomBytes(4).toString("hex"),
      handle,
      ts: Date.now(),
      body,
    };
    this.posts.push(post);
    // Drop oldest when cap is exceeded.
    if (this.posts.length > this.maxPosts) {
      this.posts.shift();
    }
    return post;
  }

  // Return all posts, newest first, capped by `limit`.
  list(limit = 500): BulletinPost[] {
    let result = this.posts.slice();
    if (limit >= 0 && limit < result.length) {
      result = result.slice(result.length - limit);
    }
    return result.reverse(); // newest first
  }

  // Delete a post by ID. Returns true if it existed and was deleted.
  delete(id: string): boolean {
    const idx = this.posts.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.posts.splice(idx, 1);
    return true;
  }
}
