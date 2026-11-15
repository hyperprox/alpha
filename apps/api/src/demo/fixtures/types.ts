// A demo fixture: a GET path (":name" segments are parameters) and what it answers with.
export interface FixtureContext {
  /** The remote cluster a page asked about (the X-HyperProx-Cluster header), or null for the home cluster. */
  cluster: string | null
}
export interface FixtureRoute {
  path: string
  get?: (params: Record<string, string>, query: Record<string, string>, ctx: FixtureContext) => unknown
  /**
   * A POST that only previews (a plan, a check, a proposal): answered with invented data so its dialog can be
   * seen. Nothing a preview answers can change anything; applying what it shows is refused like any change.
   */
  post?: (params: Record<string, string>, query: Record<string, string>, ctx: FixtureContext) => unknown
  /** A read that would reveal or open something (a secret, a shell): refused like a write. */
  refuse?: true
}
