// =============================================================================
//  HyperProx — plug-in visuals
//
//  The numbers behind each plug-in page's gauges, bars and maps. A plug-in's
//  detail() still returns its stats and tables (the "Details" section, and
//  anything else that reads them); `visual` is the same reading as typed
//  numbers, so the page never parses a display string like "1.9 Mbps" back
//  into a figure. Every field is optional on the page side: an older API that
//  sends no `visual` simply gets the tables.
// =============================================================================

export interface PlexSessionVisual {
  /** The show for an episode, else the title. */
  title:     string
  /** The episode's own name, for an episode. */
  episode:   string | null
  /** "S2 · E5" for an episode. */
  number:    string | null
  year:      number | null
  mediaType: string
  user:      string
  player:    string
  quality:   string
  /** Tautulli's decision: "transcode", "direct play" or "copy" (direct stream). */
  mode:      string
  /** "playing", "paused", "buffering". */
  state:     string
  /** 0 to 100. */
  progress:  number
  /** The poster, as a HyperProx image path (never a Plex URL, never the token), or null for the title card. */
  art?:      string | null
  /** Plex's session key, to match Tautulli's quality detail to the same stream. */
  sessionKey?: string | null
}

export interface PlexVisual {
  kind:        'plex'
  sessions:    PlexSessionVisual[]
  counts:      { streams: number; transcodes: number; direct: number }
  bandwidth:   { totalMbps: number; lanMbps: number; wanMbps: number }
  /** Last 30 days. */
  topWatchers: Array<{ user: string; minutes: number; plays: number }>
  topTitles:   Array<{ title: string; plays: number; minutes: number }>
  /** Newest first. `at` is milliseconds since the epoch, or null. */
  recent:      Array<{ at: number | null; user: string; title: string; player: string; minutes: number }>
  /** What "who watches most" is measured in: hours (Tautulli) or plays (Plex alone keeps no watch time). */
  topBy?:      'minutes' | 'plays'
  /** Each library and how many items it holds (Plex only). */
  libraries?:  Array<{ title: string; kind: string; count: number }>
  /** Read from Plex, from Tautulli, or both. */
  source?:     'plex' | 'tautulli' | 'both'
  /** Only Tautulli is set: the page asks for the Plex server for live data. */
  needsPlex?:  boolean
}

export type ArrDownloadState = 'downloading' | 'seeding' | 'stalled' | 'queued' | 'checking' | 'paused' | 'other'

export interface ArrVisual {
  kind:      'arrstack'
  pipeline: {
    indexersOn: number; indexersTotal: number; indexersFailing: number
    /** Items in the Sonarr and Radarr queues. */
    queued: number
    downloading: number; stalled: number; seeding: number
    importBlocked: number
    /** Bytes per second, or null without qBittorrent. */
    downBps: number | null; upBps: number | null
  }
  /** Imports that will not resolve themselves. `downloadId` matches the /stuck list's id. */
  blocked:   Array<{ service: string; title: string; reason: string; downloadId: string | null }>
  downloads: Array<{ name: string; progress: number; sizeBytes: number; downBps: number; upBps: number; etaSec: number | null; state: ArrDownloadState; category: string | null }>
  indexers:  Array<{ name: string; state: 'ok' | 'failing' | 'off' }>
  health:    Array<{ service: string; level: 'error' | 'warning' | 'notice'; message: string }>
  services:  Array<{ name: string; up: boolean }>
  /** Lidarr's library, when Lidarr is set up: absent otherwise, so a page shows nothing about music. */
  music?:    { artists: number; albums: number; tracks: number; sizeBytes: number; missingAlbums: number | null } | null
}

export interface UnmanicVisual {
  kind:    'unmanic'
  workers: Array<{
    name: string; up: boolean
    busy: number; idle: number; paused: number; slots: number; pending: number
    /** The file's name only, never its path. */
    encoding: Array<{ worker: string; file: string; progress: number | null; elapsedSec: number | null }>
  }>
  totals:  { busy: number; idle: number; paused: number; pending: number; slots: number }
}

export interface RouterVisual {
  kind:    'mikrotik'
  router:  { name: string; model: string; version: string; uptime: string }
  /** Every internet-facing interface, bits per second. */
  wans:    Array<{ name: string; downBps: number; upBps: number }>
  total:   { downBps: number; upBps: number }
  health:  { cpuPct: number; cpuCores: number | null; memPct: number; tempC: number | null; voltage: number | null }
  subnets: Array<{ net: string; uplink: string | null; devices: number; downBps: number; upBps: number }>
  /** Busiest first. `source` says where the name came from. */
  talkers: Array<{ name: string | null; ip: string; downBps: number; upBps: number; source: 'router' | 'cluster' | 'none' }>
  forwards: Array<{ name: string; proto: string; port: string; to: string; toName: string | null; active: boolean; bytes: number }>
  forwardsActive: number
  log:     Array<{ time: string; message: string; level: 'error' | 'warning' | 'info'; /** RouterOS topics, e.g. "system,error". */ topic?: string }>
}

export interface MeshVisual {
  kind:      'meshcentral'
  /** False until the plug-in has a way to read MeshCentral's device list. */
  connected: boolean
  publicUrl: string | null
  /** What is needed before devices can be shown, in plain words. */
  needs:     string[]
  /** One tile per device once connected. `id` is MeshCentral's node id, for the remote-desktop action to come. */
  devices?:  Array<{ id: string; name: string; os: string | null; online: boolean; group: string | null }>
}

export type PluginVisual = PlexVisual | ArrVisual | UnmanicVisual | RouterVisual | MeshVisual
