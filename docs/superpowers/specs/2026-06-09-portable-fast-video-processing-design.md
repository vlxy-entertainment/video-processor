# Portable, Fast Video Processing — Design

**Date:** 2026-06-09
**Status:** Approved for planning
**Affects:** `src/services/videoProcessor.ts`, `src/services/encoding/*`

## Problem

The processing pipeline is locked to a single machine and always does the most
expensive thing possible:

1. **GPU-locked.** `EncodingStrategyFactory.createStrategy()` always returns
   `NvidiaEncodingStrategy('p1')`; hardware detection was never implemented. The
   "CPU fallback" `try/catch` in `videoProcessor.ts` re-creates the *same* NVENC
   strategy, so it does not fall back. The binary cannot run on a server without
   NVENC (e.g. a cloud box, the user's stated goal).
2. **Always re-encodes.** Every source is transcoded through NVENC (H.264, CBR
   10 Mbps, preset `p1`) even when the source is already a perfectly playable
   stream that could be copied without decoding.
3. **Redundant post-processing I/O.** Each segment is read and written three
   times (strip FFmpeg metadata → embed into PNG → delete `.ts`).

## Goals

- **Runs on any server** — the same binary works on the user's RTX 4060 Ti, a
  GPU cloud instance, or a CPU-only cloud box.
- **Fast** — the common case avoids re-encoding entirely.
- **Visually identical or better** — the copy path is bit-identical; the
  transcode path stays visually indistinguishable from today.
- **Same output format** — PNG-wrapped HLS segments + embedded playlist,
  uploaded to TikTok's image CDN. Unchanged. This is the project's core trick
  and is not negotiable.

## Non-goals

- Replacing the HLS-in-PNG steganography or the upload orchestrator.
- Managed cloud encoders (AWS MediaConvert / Mux / Cloudflare Stream). They
  cannot emit PNG-wrapped HLS, so custom packaging would still be required —
  added cost, no removed work. Explicitly rejected.
- Changing the queue/Supabase data model.

## Key constraints (from brainstorming)

- **"Same output" = visually identical, any codec.** Encoder, codec, and
  bitrate are free to change; the PNG-wrapped HLS format is fixed.
- **Playback client is codec-agnostic.** It can decode anything playable, so the
  routing decision needs **no codec allowlist and no resolution check for their
  own sake** — both matter only insofar as they affect segment size.
- **`<5 MB` per segment** is the hard hosting constraint (TikTok image upload).
- Detection of hardware must happen **once at startup**, not per video.

## Research basis

- **Stream copy (`-c copy`) is 10–50× faster and bit-identical**, and needs no
  GPU — it runs on the cheapest CPU box. Its one limitation: it can only cut
  segments at existing keyframes, so segment duration cannot be forced to 5 s and
  a segment can be as large as `bitrate × max-keyframe-gap`.
  ([keyframe/copy limitation](https://www.mux.com/articles/clip-sections-of-a-video-with-ffmpeg))
- **When transcoding is required, libx264 is the portable floor** — slightly
  better quality and smaller files than NVENC at equal bitrate, just slower.
  NVENC is ~10× faster at near-equal quality above ~10 Mbps. So: NVENC when a GPU
  exists, libx264 everywhere else.
  ([NVENC vs x264 2026](https://www.faceofit.com/nvenc-vs-x264/),
  [GPU hardware encoders](https://chipsandcheese.com/p/gpu-hardware-video-encoders-how-good-are-they))

## Architecture

A **probe-and-route** decision replaces the straight-line transcode. The
pipeline becomes:

```
ffprobe source
   │
   ├─ REMUX route   ── -c copy into HLS         (no decode, no GPU, bit-identical)
   │                   chosen when predicted max segment < 5 MB
   │
   └─ TRANSCODE route ── encoder ladder          (only when copy is unsafe)
                          NVENC → QSV/VAAPI/AMF → libx264
                          downscale to 1080p + capped-quality re-encode
   │
   └─► fused post-process (single pass): strip metadata + wrap in PNG
   └─► update + embed playlist PNG  (unchanged)
   └─► validate                     (unchanged)
```

### Component 1: Source probe + route decision

A new unit (e.g. `ProcessingPlanner`) that takes the source URL and returns a
`ProcessingPlan`:

```
ProcessingPlan = { route: 'remux' | 'transcode', reason: string }
```

**Decision rule — the segment-size guard is the only gate:**

- Probe via ffprobe: average/peak bitrate and **max keyframe (I-frame)
  interval**. The keyframe spacing is found by reading packet keyframe flags
  (e.g. `ffprobe -select_streams v -show_packets -show_entries
  packet=pts_time,flags` and measuring the largest gap between keyframes), or an
  equivalent that yields the worst-case GOP duration.
- **Predicted max segment bytes ≈ peak_bitrate × max_keyframe_gap_seconds.**
  Apply a safety margin (e.g. 0.8 × the 5 MB budget) to absorb estimation error.
- If predicted max segment < budget → **REMUX**. Otherwise → **TRANSCODE**.

No codec or resolution branch: a codec-agnostic player makes those irrelevant
except through their effect on bitrate/segment size, which the guard already
captures. A 4K high-bitrate source naturally fails the guard and routes to
transcode (where it is downscaled), which is the correct outcome.

### Component 2: REMUX route

`-c copy` (both video and audio) into the HLS muxer:

- `-hls_time 5` acts as a *minimum* target; the muxer splits at the first
  keyframe at or after 5 s, so segments are ≥ 5 s and aligned to source
  keyframes.
- `-hls_list_size 0`, `-hls_flags independent_segments`, same
  `segment_%03d.ts` / `playlist.m3u8` outputs as today.
- No scale filter, no encoder options.
- **Post-condition re-check:** after segmentation, the existing
  `validateSegmentSizes()` runs; if any segment unexpectedly exceeds 5 MB (the
  prediction was wrong), the item falls back to the TRANSCODE route once. This
  makes the guard's safety margin a soft predictor backed by a hard check.

### Component 3: Encoder ladder (TRANSCODE route)

Fix `EncodingStrategyFactory` to perform **real** detection:

- `createStrategy()` probes available encoders **once at process startup**,
  caches the winner, and returns it for every subsequent call.
- Priority order: **NVENC → QSV/VAAPI/AMF → libx264**. libx264 is the guaranteed
  terminal fallback (always available), so a CPU-only box always has a working
  encoder.
- Each strategy's `isAvailable()` runs a 1-frame test encode (the NVENC one
  already exists). Detection failures are non-fatal — fall through to the next.
- Remove the dead "CPU fallback" `try/catch` in `videoProcessor.ts` that
  re-creates the same strategy; real fallback now lives in the factory.

Transcode encoding settings:

- **Capped-quality (CQ/CRF) instead of fixed CBR 10 Mbps**, with a max bitrate
  cap. A modest source is no longer inflated to 10 Mbps — smaller files, fewer
  segments, still visually identical. The cap keeps high-bitrate sources within
  the segment budget.
- Downscale to 1080p when larger (as today).
- **Fix the conflicting keyframe flags.** Today the strategy sets `-g 30` +
  keyframes every 1 s while `runFFmpegConversion` sets `-g 150` + keyframes every
  5 s. Consolidate to a single source of truth: keyframes exactly at the 5 s
  segment boundary so each transcoded segment is independent and cuts cleanly.

### Component 4: Fused post-processing

Today: `removeFFmpegMetadataFromTsSegments()` (read+write) →
`embedSegmentsToPng()` (read+write) → `cleanupTsFiles()` (delete) = three passes
per segment.

Fuse into a single `read .ts → strip metadata → prepend PNG → write .png`
per segment, then remove the `.ts`. One read and one write per segment instead
of three. Applies to **both** routes (remux segments still need metadata strip +
PNG wrap). The PNG↔payload boundary contract (`IEND` signature
`49 45 4E 44 AE 42 60 82`) is preserved exactly — the orchestrator's extraction
side is untouched.

## Data flow

`ProcessingService.processNextVideo()` is unchanged at the call site: it still
calls `VideoProcessor.processVideo(videoUrl, queueItemId)`. Inside:

1. Probe source → `ProcessingPlan`.
2. REMUX or TRANSCODE per the plan → `.ts` segments + `playlist.m3u8`.
3. Fused strip+wrap → `.png` segments.
4. `updatePlaylistToUsePng` → `embedPlaylistToPng` → `validateConversion`
   (unchanged).
5. On REMUX, if `validateSegmentSizes` finds an over-budget segment, redo once
   via TRANSCODE.

Downstream (`TiktokUploadOrchestrator`, `videos` row, IndexNow) is unchanged.

## Error handling

- Probe failure → default to TRANSCODE (safe, always works). Log the reason.
- All encoder strategies unavailable → impossible by construction (libx264 is
  the terminal fallback), but if even libx264 fails, the existing
  `processNextVideo` failure path marks the queue item `failed`, progress `0`,
  and cleans the output folder. Unchanged.
- REMUX over-budget segment → single TRANSCODE retry; if that also fails, normal
  failure path.

## Testing / verification

No automated test suite exists. Verify with:

- `pnpm type-check` and `pnpm lint:check` (required before claiming done).
- Manual: run a known-H.264-1080p source → confirm REMUX route, segments < 5 MB,
  playlist plays, much faster than baseline.
- Manual: run a 4K or HEVC-high-bitrate source → confirm TRANSCODE route and
  encoder selection logged (NVENC on the 4060 Ti).
- Manual on a CPU-only environment (or with NVENC forced unavailable) → confirm
  the ladder lands on libx264 and still produces valid output.
- Confirm output PNGs still extract correctly through the orchestrator's `IEND`
  logic (upload path unchanged).

## Risks & mitigations

- **Segment-size misprediction on REMUX** → hard `validateSegmentSizes` re-check
  with a one-shot TRANSCODE fallback; conservative 0.8× safety margin.
- **Variable segment durations on REMUX** (keyframe-aligned, not exactly 5 s) →
  acceptable; HLS supports variable `#EXTINF` durations and the player is
  codec/format-agnostic. The `<5 MB` budget is the only hard constraint.
- **Encoder detection cost** → run once at startup and cache; never per video.

## Out of scope / future

- Per-source bitrate ladders / multiple renditions.
- Parallelizing segment PNG-wrapping across workers.
- Replacing fluent-ffmpeg.
