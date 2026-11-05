// WireGuard client keys made in the browser (WebCrypto X25519). The private key goes to HyperProx once, to be
// kept in the vault item for that peer, and is never stored by the page. Null when the browser cannot do it;
// the page then asks the server container to make the pair instead.

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))))

export async function browserKeypair(): Promise<{ publicKey: string; privateKey: string } | null> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const pair = await subtle.generateKey({ name: 'X25519' } as any, true, ['deriveBits']) as CryptoKeyPair
    const pub = await subtle.exportKey('raw', pair.publicKey)
    // PKCS#8 for X25519 is a fixed 16-byte header and the 32-byte key.
    const pk8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey))
    if (pk8.length !== 48 || new Uint8Array(pub).length !== 32) return null
    return { publicKey: b64(pub), privateKey: b64(pk8.slice(16)) }
  } catch { return null }
}
