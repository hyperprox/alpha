// Preload form of ./no-outbound: `node --require <compiled>/demo/no-outbound-register.js` installs the guard
// before anything else in that process runs. The public demo starts its frontend (next start) this way.
import { installNoOutbound } from './no-outbound'

installNoOutbound()
