// The session cookie gets `Secure` when the browser came over https (nginx's X-Forwarded-Proto), so a
// session made on the https front door is never sent back over plain http.
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildAuthCookie, requestIsHttps } from "../src/lib/auth"

test("https through nginx: Secure", () => {
  assert.match(buildAuthCookie("t", 60, { "x-forwarded-proto": "https" }), /; Secure$/)
})

test("plain http, or no headers at all: no Secure, otherwise unchanged", () => {
  const plain = "hyperprox_token=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=60"
  assert.equal(buildAuthCookie("t", 60), plain)
  assert.equal(buildAuthCookie("t", 60, {}), plain)
  assert.equal(buildAuthCookie("t", 60, { "x-forwarded-proto": "http" }), plain)
})

test("the clearing cookie carries the same attribute, so it replaces the Secure one", () => {
  assert.equal(buildAuthCookie("", 0, { "x-forwarded-proto": "https" }), "hyperprox_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure")
})

test("a proxy chain's first hop decides; case does not matter", () => {
  assert.equal(requestIsHttps({ "x-forwarded-proto": "HTTPS, http" }), true)
  assert.equal(requestIsHttps({ "x-forwarded-proto": "http, https" }), false)
  assert.equal(requestIsHttps({ "x-forwarded-proto": ["https"] }), false)
})
