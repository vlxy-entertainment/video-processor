# Video Processing and HLS-in-PNG Steganography

Covers how source video is transcoded to HLS, how each HLS segment (and the playlist) is disguised as a PNG for hosting on TikTok's image CDN, the byte-level boundary that ties the writer and reader together, and the current reality of the encoding strategy selection.

Source files referenced:
- [`src/services/videoProcessor.ts`](../../src/services/videoProcessor.ts)
- [`src/services/tiktokUploadOrchestrator.ts`](../../src/services/tiktokUploadOrchestrator.ts)
- [`src/services/encoding/EncodingStrategy.ts`](../../src/services/encoding/EncodingStrategy.ts)
- [`src/services/encoding/EncodingStrategyFactory.ts`](../../src/services/encoding/EncodingStrategyFactory.ts)
- [`src/services/encoding/NvidiaEncodingStrategy.ts`](../../src/services/encoding/NvidiaEncodingStrategy.ts)
- [`src/services/encoding/CpuEncodingStrategy.ts`](../../src/services/encoding/CpuEncodingStrategy.ts)
- [`src/services/encoding/AmdEncodingStrategy.ts`](../../src/services/encoding/AmdEncodingStrategy.ts)
- [`src/services/encoding/AppleVideoToolboxEncodingStrategy.ts`](../../src/services/encoding/AppleVideoToolboxEncodingStrategy.ts)
- [`src/services/encoding/IntelQsvEncodingStrategy.ts`](../../src/services/encoding/IntelQsvEncodingStrategy.ts)

---

## 1. Why this exists

TikTok's image CDN (`api/upload/image/`) serves uploaded files from a stable, publicly reachable URL. TikTok's video upload API does not offer the same raw-URL guarantee. The exploit: the CDN validates files with a PNG signature check but does not re-encode or strip trailing bytes. By placing a valid PNG header in front of an HLS segment's bytes, the resulting file passes CDN ingestion and can be retrieved byte-for-byte via its CDN URL. The receiving HLS player discards the leading PNG header and reads the MPEG-TS payload that follows.

---

## 2. Transcode → embed pipeline (`videoProcessor.ts`)

`VideoProcessor.processVideo()` runs eight sequential steps:

```
Step 1  mkdir processed/<queueItemId>/
Step 2  convertVideoToHLS()        → segment_000.ts … segment_NNN.ts + playlist.m3u8
Step 3  removeFFmpegMetadataFromTsSegments()
Step 4  embedSegmentsToPng()       → segment_000.png … segment_NNN.png
Step 5  updatePlaylistToUsePng()   → rewrite .ts → .png in playlist.m3u8
Step 6  embedPlaylistToPng()       → playlist.png  (original .m3u8 deleted)
Step 7  cleanupTsFiles()           → delete segment_*.ts
Step 8  validateConversion()
```

### Step 2 — HLS transcode

FFmpeg is invoked with `-f hls -hls_time 5 -hls_list_size 0 -hls_segment_filename segment_%03d.ts`. Segment duration is fixed at 5 seconds:

```ts
// videoProcessor.ts  calculateSegmentDuration()
const fixedSegmentDuration = 5;
```

The target segment size ceiling is 5 MB (`private readonly maxSegmentSizeMB = 5`).

### Step 3 — MPEG-TS metadata strip

FFmpeg injects an encoder-identification packet into the first 188-byte MPEG-TS packet of each segment. The stripper finds the `"FFmpeg"` string in the first packet, extracts the header bytes that precede it, then splices in the rest of the file starting from the next MPEG-TS sync byte (`0x47`):

```ts
// videoProcessor.ts  removeFFmpegMetadataFromTsSegments()
const ffmpegStart = segmentData.indexOf(Buffer.from('FFmpeg'));
const packetHeader = segmentData.subarray(0, ffmpegStart - 6); // 6 bytes before "FFmpeg"
let nextSyncByte = firstPacketEnd; // 188
while (nextSyncByte < segmentData.length && segmentData[nextSyncByte] !== 0x47) {
  nextSyncByte++;
}
const cleanedData = Buffer.concat([packetHeader, segmentData.subarray(nextSyncByte)]);
```

Segments that do not contain `"FFmpeg"` are left unchanged.

### Step 4 — Embed segments into PNG

Each cleaned `.ts` file is appended to a hard-coded 1×1 transparent PNG (70 bytes, base64-encoded inline):

```ts
// videoProcessor.ts  embedSegmentInPng()
const workingPngBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const pngBuffer = Buffer.concat([workingPngBuffer, segmentData]);
fsSync.writeFileSync(finalOutputPath, pngBuffer);
```

The 1×1 PNG is exactly 70 bytes; its `IEND` chunk occupies bytes 62–69 (`49 45 4E 44 AE 42 60 82`). Segment data therefore starts at byte 70 of every output file.

### Step 5 — Rewrite playlist references

A global string replacement swaps every `.ts` extension to `.png` in `playlist.m3u8`:

```ts
// videoProcessor.ts  updatePlaylistToUsePng()
playlistContent = playlistContent.replace(/\.ts/g, '.png');
```

### Step 6 — Embed playlist into PNG

The updated `playlist.m3u8` is passed through the same `embedSegmentInPng()` path, producing `playlist.png`. The original `.m3u8` file is then deleted. The playlist bytes follow the same 70-byte PNG header, so extraction is identical to segment extraction.

---

## 3. Embed / extract diagram

```mermaid
flowchart LR
    src[source video] --> hls[HLS transcode<br/>.ts segments + playlist.m3u8]
    hls --> strip[strip MPEG-TS metadata<br/>sync byte 0x47]
    strip --> wrap[concat after 1x1 PNG bytes<br/>→ segment .png files]
    wrap --> rw[rewrite playlist .ts → .png]
    rw --> pw[embed playlist into PNG]
    pw --> out[processed/&lt;queueItemId&gt;/]
    out -. extract: read bytes after IEND .-> ex[recover .ts / playlist]
```

---

## 4. The PNG ↔ payload boundary — the IEND signature

Every file produced by this pipeline shares the same layout:

```
[bytes 0–69]   valid 1×1 PNG  (PNG header + IDAT + IEND chunk)
[bytes 70+]    raw payload    (.ts segment bytes  OR  M3U8 text)
```

The boundary is the PNG `IEND` chunk: four bytes for the chunk type `IEND` (`49 45 4E 44`) followed by the four-byte CRC `AE 42 60 82`. Payload extraction means finding this 8-byte sequence and reading everything after it.

Both extractor implementations arrive at byte offset 70, but they locate the boundary differently.

**Writer** (`videoProcessor.ts` `embedSegmentInPng`): performs a plain `Buffer.concat([workingPngBuffer, segmentData])`. It does not inspect the IEND location; it relies on the fixed 70-byte PNG buffer to place the payload at a known offset.

**Reader — internal validation** (`videoProcessor.ts` `extractM3u8FromPng`): searches for the 4-byte chunk-type `"IEND"` (`[0x49, 0x45, 0x4e, 0x44]`), then starts the payload at `iendIndex + 8` (4 bytes for `IEND` + 4 bytes for the CRC):

```ts
// videoProcessor.ts  extractM3u8FromPng()
const iendMarker = Buffer.from([0x49, 0x45, 0x4e, 0x44]); // "IEND"
const iendIndex = pngBuffer.indexOf(iendMarker);
const m3u8StartIndex = iendIndex + 8; // IEND + CRC
```

**Reader — upload orchestration** (`tiktokUploadOrchestrator.ts` `extractM3U8FromPNG` and `embedM3U8IntoPNG`): searches for the full 8-byte IEND+CRC signature, then starts the payload at `iendIndex + iendSignature.length` (also 8):

```ts
// tiktokUploadOrchestrator.ts  extractM3U8FromPNG()
const iendSignature = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const iendIndex = pngBuffer.indexOf(iendSignature);
const m3u8StartIndex = iendIndex + iendSignature.length; // +8
```

Both arrive at the same byte (70 in the fixed-size 1×1 PNG), so they are consistent in practice. However, the two approaches would diverge if the PNG header were ever changed: `videoProcessor`'s extractor finds the first occurrence of the 4-byte text `IEND` (which could match data inside an IDAT chunk), while `tiktokUploadOrchestrator` requires the full 8-byte sequence (type + CRC), which is far less likely to produce a false match. The orchestrator's approach is more robust.

---

## 5. Encoding strategies — design vs. reality

### Strategy interface and implementations

`EncodingStrategy` (`src/services/encoding/EncodingStrategy.ts`) defines a three-method interface: `getName()`, `isAvailable(): Promise<boolean>`, and `getOptions(metadata): string[]`.

Five concrete implementations exist:

| Class | FFmpeg codec | `getName()` return |
|---|---|---|
| `NvidiaEncodingStrategy` | `h264_nvenc` | `"NVIDIA NVENC"` |
| `AmdEncodingStrategy` | `h264_amf` | `"AMD AMF"` |
| `AppleVideoToolboxEncodingStrategy` | `h264_videotoolbox` | `"Apple VideoToolbox"` |
| `IntelQsvEncodingStrategy` | `h264_qsv` | `"Intel Quick Sync Video"` |
| `CpuEncodingStrategy` | `libx264` | `"CPU (libx264)"` |

Each `isAvailable()` probes the local FFmpeg binary with a 1-second test encode. `CpuEncodingStrategy.getOptions()` takes no arguments (unlike the hardware strategies, which accept `FfprobeData` to calculate bitrate).

### The factory always returns NVENC — hardware detection is stubbed

`EncodingStrategyFactory.createStrategy()` does not call `isAvailable()` on any strategy. It unconditionally returns `NvidiaEncodingStrategy('p1')`:

```ts
// EncodingStrategyFactory.ts
static async createStrategy(): Promise<EncodingStrategy> {
  // Always use NVIDIA NVENC encoder
  logger.info('🚀 Using NVIDIA NVENC encoding strategy');
  return new NvidiaEncodingStrategy('p1');
}
```

Similarly `getAvailableStrategies()` always returns `[new NvidiaEncodingStrategy('p1')]`. The factory was written to support hardware detection but that logic was never implemented.

### The CPU fallback does not fall back

`videoProcessor.ts` wraps `convertVideoToHLS()` in a `try/catch` that is labeled "CPU fallback":

```ts
// videoProcessor.ts  convertVideoToHLS()
} catch (error) {
  logger.warn('⚠️ Hardware encoding failed, trying CPU fallback:', error);
  try {
    const encodingStrategy = await EncodingStrategyFactory.createStrategy();
    // ...
    logger.info(`🔄 Using CPU fallback encoding: ${encodingStrategy.getName()}`);
    await this.runFFmpegConversion(inputPath, outputDir, segmentDuration, encodingOptions);
```

Because `EncodingStrategyFactory.createStrategy()` always returns `NvidiaEncodingStrategy`, the catch block re-creates the same NVENC strategy and retries the identical FFmpeg command. If NVENC failed in the first attempt it will fail again. `CpuEncodingStrategy` is never instantiated anywhere in the production call path.

**Summary of mismatches with documentation:**

| Claim | Reality |
|---|---|
| "Automatic hardware detection selects the best available encoder" | `createStrategy()` returns NVENC unconditionally; no detection runs |
| "Falls back to CPU encoding if hardware encoding fails" | The catch block calls `createStrategy()` again, getting NVENC a second time |
| `CpuEncodingStrategy`, `AmdEncodingStrategy`, etc. are code that exists | All are dead code in the production path — only `NvidiaEncodingStrategy('p1')` is ever used |

The fix would be to implement `createStrategy()` to iterate the hardware strategies in priority order (calling `isAvailable()` on each) and fall back to `CpuEncodingStrategy` as the final option.
