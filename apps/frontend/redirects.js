// Pages that moved. Old links and bookmarks keep working: Placement became Load balancing.
// Kept apart from next.config.js so a test can read the list without running the build config.
module.exports = [
  { source: '/placement', destination: '/balance', permanent: true },
  { source: '/settings/placement', destination: '/settings/balance', permanent: true },
]
