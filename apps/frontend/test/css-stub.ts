// Lets a test import a component that imports a CSS module: each class name comes back as itself.
const ext = (require as any).extensions
ext['.css'] = (m: any) => { m.exports = new Proxy({}, { get: (_t, k) => (k === '__esModule' ? false : String(k)) }) }
export {}
