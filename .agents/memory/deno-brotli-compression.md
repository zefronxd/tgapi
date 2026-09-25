---
name: Deno Brotli compression
description: Runtime-specific guidance for Brotli response compression in this Deno project.
---

Deno's native `CompressionStream` supports gzip and deflate here, but rejects
the `br` format. Brotli response encoding should use the runtime's built-in
`node:zlib` `brotliCompressSync` implementation, with gzip and identity
fallbacks negotiated from `Accept-Encoding`.

**Why:** Relying on `CompressionStream("br")` fails at runtime before a
response can be sent, while adding a third-party encoder is unnecessary.

**How to apply:** Keep compression centralized around the HTTP response
handler, limit it to text-like content, and leave already encoded media
responses untouched.