---
scope: "The video processing/upload pipeline: HLS conversion, the PNG-embedding steganography used to host segments on TikTok's image CDN, and encoding-strategy behavior."
not: "General coding conventions (see conventions.md) or runtime/tooling setup (see tech-stack.md)."
anchors:
  - "Segments and playlist are byte-appended after a 1×1 PNG to host on TikTok's image CDN"
  - "EncodingStrategyFactory always returns NVIDIA NVENC (detection is stubbed)"
---

## Segments and playlist are byte-appended after a 1×1 PNG to host on TikTok's image CDN

The core trick of the project: `videoProcessor.ts` transcodes to HLS, then concatenates each `.ts` segment (and the `m3u8` playlist) **after** the bytes of a 1×1 PNG, producing valid-looking `.png` files uploaded to TikTok's `api/upload/image/` endpoint. Extraction finds the PNG `IEND` chunk (`49 45 4E 44 AE 42 60 82`) and reads everything after it. The playlist's segment references are rewritten to the returned CDN URLs, re-embedded, and the playlist PNG URL is stored in `videos.hls_playlist_url`.

**Why:** The IEND boundary contract must stay consistent between the writer (`videoProcessor.ts`) and reader (`tiktokUploadOrchestrator.ts`); changing one side silently breaks extraction.

---

## EncodingStrategyFactory always returns NVIDIA NVENC (detection is stubbed)

`EncodingStrategyFactory.createStrategy()` always returns `NvidiaEncodingStrategy('p1')`. The other strategy classes (AMD/Apple/Intel QSV/CPU) exist but are unused, and `videoProcessor`'s "CPU fallback" `try/catch` re-creates the same NVENC strategy, so it does not actually fall back. The README's automatic-hardware-detection claims do not match the code.

**Why:** Don't trust the README here — the box must have NVIDIA NVENC available, and "fixing" the fallback requires changing the factory, not the processor.

---
