'use client'

// A remote cluster's Updates page: the same page as /updates. The path names the cluster, and every API call
// from here carries it (lib/api.ts), so it reads and changes only that server.
export { default } from '../../../updates/page'
