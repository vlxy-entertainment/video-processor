---
scope: "The video processing/upload pipeline: HLS conversion, the PNG-embedding steganography used to host segments on TikTok's image CDN, and encoding-strategy behavior."
not: "General coding conventions (see conventions.md) or runtime/tooling setup (see tech-stack.md)."
anchors:
  - "Segments and playlist are byte-appended after a 1×1 PNG to host on TikTok's image CDN"
  - "EncodingStrategyFactory always returns NVIDIA NVENC (detection is stubbed)"
  - "TikTok upload form must include source='0' or the CDN strips bytes after IEND"
---

## Segments and playlist are byte-appended after a 1×1 PNG to host on TikTok's image CDN

The core trick of the project: `videoProcessor.ts` transcodes to HLS, then concatenates each `.ts` segment (and the `m3u8` playlist) **after** the bytes of a 1×1 PNG, producing valid-looking `.png` files uploaded to TikTok's `api/upload/image/` endpoint. Extraction finds the PNG `IEND` chunk (`49 45 4E 44 AE 42 60 82`) and reads everything after it. The playlist's segment references are rewritten to the returned CDN URLs, re-embedded, and the playlist PNG URL is stored in `videos.hls_playlist_url`.

**Why:** The IEND boundary contract must stay consistent between the writer (`videoProcessor.ts`) and reader (`tiktokUploadOrchestrator.ts`); changing one side silently breaks extraction.

---

## EncodingStrategyFactory always returns NVIDIA NVENC (detection is stubbed)

`EncodingStrategyFactory.createStrategy()` always returns `NvidiaEncodingStrategy('p1')`. The other strategy classes (AMD/Apple/Intel QSV/CPU) exist but are unused, and `videoProcessor`'s "CPU fallback" `try/catch` re-creates the same NVENC strategy, so it does not actually fall back. The README's automatic-hardware-detection claims do not match the code.

**Why:** Don't trust the README here — the box must have NVIDIA NVENC available, and "fixing" the fallback requires changing the factory, not the processor.

---

## TikTok upload form must include source='0' or the CDN strips bytes after IEND

Every upload to `api/upload/image/` must append the multipart field `source='0'` (`TiktokUploadService.performUpload`, and the sibling `tiktok-upload-service`). With it, TikTok stores the upload in its origin-preserving object store (returned uri `tos-alisg-avt-*`) and serves the raw bytes. Without it, the upload lands in the `tiktok-obj` bucket, gets re-encoded as a plain image, and **every byte after the PNG `IEND` chunk is discarded** — the hosted PNG comes back as a bare ~70-byte 1×1 image, so the embedded HLS segment/playlist payload is lost and playback breaks even though the upload reports `status_code:0` success.

**Why:** User correction after a prior session removed `source='0'` as "unused" (commit `1c8e86a`), which silently broke the steganography for newly-processed videos while old ones kept working. The field is load-bearing, not optional. See [[segments-and-playlist-are-byte-appended-after-a-1x1-png]].

---

## Remux is gated to H.264+AAC; segment size = bitrate × (hls_time + maxKeyframeGap)

`ProcessingPlanner` chooses **remux** (`-c copy`) over **transcode** only when BOTH gates pass: (1) **codec** — video is `h264` and audio is `aac` or absent (ffprobe `codec_name`); (2) **size** — predicted worst-case segment ≤ `MAX_SEGMENT_SIZE_MB × SEGMENT_SIZE_SAFETY_MARGIN`. The size prediction is `bitrate/8 × (HLS_SEGMENT_DURATION_SECONDS + maxKeyframeGap)`, **not** `× maxKeyframeGap` alone — a remux cut lands on a keyframe at/after the duration target, so a segment runs ~`hls_time` long plus up to one gap. The `validateSegmentSizes → transcode` fallback remains as a rare VBR-peak safety net.

**Why:** The website (`video-streaming`) plays via hls.js/MediaSource with no codec validation and reliably decodes only H.264+AAC, so remuxing HEVC/VP9/AV1/Opus uploads fine but fails playback silently. The old gap-only formula under-predicted dense-keyframe sources ~5×, wrongly chose remux, and produced mass-oversize segments that fell back to a full transcode anyway (wasted pass + slow processing). Verified with live ffmpeg segmentation and real ffprobe codec strings. See [[encodingstrategyfactory-always-returns-nvidia-nvenc-detection-is-stubbed]].

---
