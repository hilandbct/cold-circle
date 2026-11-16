// Config loading and validation. The server reads a single YAML file
// (coldcircle.config.yaml) and fills in defaults for any omitted field, so a
// partial config still boots. See spec §3.1.

import { readFile } from "node:fs/promises";
import * as yaml from "js-yaml";

export interface ServerConfig {
  bind: string;
  port: number;
  passphrase: string;
  admin_passphrase: string;
  tls?: { cert: string; key: string };
}
export interface ChatConfig {
  default_channel: string;
  public_retention_sec: number;
  max_buffer_messages: number;
  sweep_interval_sec: number;
}
export interface FilesConfig {
  root: string;
  max_upload_bytes: number;
  allow_extensions: string[];
}
export interface BulletinConfig {
  max_posts: number;
  max_post_bytes: number;
}
export interface TrackingConfig {
  enabled: boolean;
  registry_url: string;
  server_name: string;
  description: string;
  heartbeat_sec: number;
}

export interface Config {
  server: ServerConfig;
  chat: ChatConfig;
  files: FilesConfig;
  bulletin: BulletinConfig;
  tracking: TrackingConfig;
}

// A fully-populated default config. Anything the user omits falls back to here.
const DEFAULTS: Config = {
  server: {
    bind: "0.0.0.0",
    port: 8443,
    passphrase: "correct-horse-battery",
    admin_passphrase: "root-access-123",
  },
  chat: {
    default_channel: "#general",
    public_retention_sec: 3600,
    max_buffer_messages: 2000,
    sweep_interval_sec: 30,
  },
  files: {
    root: "./share",
    max_upload_bytes: 268435456,
    allow_extensions: ["*"],
  },
  bulletin: {
    max_posts: 500,
    max_post_bytes: 32768,
  },
  tracking: {
    enabled: false,
    registry_url: "https://registry.coldcircle.net",
    server_name: "Nightfall",
    description: "Late-night talks, files, and noise.",
    heartbeat_sec: 60,
  },
};

export async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read config at ${path}: ${(err as Error).message}. ` +
        `Copy coldcircle.config.example.yaml to coldcircle.config.yaml to start.`,
    );
  }

  const parsed = (yaml.load(raw) as Record<string, unknown>) ?? {};
  const cfg: Config = structuredClone(DEFAULTS);

  if (parsed.server && typeof parsed.server === "object") {
    Object.assign(cfg.server, parsed.server);
  }
  if (parsed.chat && typeof parsed.chat === "object") {
    Object.assign(cfg.chat, parsed.chat);
  }
  if (parsed.files && typeof parsed.files === "object") {
    Object.assign(cfg.files, parsed.files);
  }
  if (parsed.bulletin && typeof parsed.bulletin === "object") {
    Object.assign(cfg.bulletin, parsed.bulletin);
  }
  if (parsed.tracking && typeof parsed.tracking === "object") {
    Object.assign(cfg.tracking, parsed.tracking);
  }

  validate(cfg);
  return cfg;
}

function validate(cfg: Config): void {
  if (!cfg.server.passphrase || !cfg.server.admin_passphrase) {
    throw new Error("server.passphrase and server.admin_passphrase are both required.");
  }
  if (cfg.server.passphrase === cfg.server.admin_passphrase) {
    throw new Error("server.passphrase and server.admin_passphrase must differ.");
  }
  if (!Number.isFinite(cfg.chat.public_retention_sec) || cfg.chat.public_retention_sec < 0) {
    throw new Error("chat.public_retention_sec must be a non-negative number of seconds.");
  }
  if (!Number.isFinite(cfg.chat.max_buffer_messages) || cfg.chat.max_buffer_messages < 1) {
    throw new Error("chat.max_buffer_messages must be a positive integer.");
  }
}
