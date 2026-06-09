# Portable, Fast Video Processing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make video processing run on any server (GPU or CPU-only) and skip re-encoding whenever the source can be remuxed, while keeping the PNG-wrapped HLS output identical.

**Architecture:** Insert a probe-and-route decision before encoding. Remux (`-c copy`) when a quick probe predicts every segment will stay under the size budget; otherwise transcode through an encoder ladder that is detected once at startup (NVENC → Intel QSV → libx264). Collapse the three post-encode passes (metadata-strip, PNG-embed, cleanup) into one. Fix the keyframe-flag conflict so transcoded segments cut cleanly.

**Tech Stack:** TypeScript (Node, ts-node), fluent-ffmpeg, system `ffmpeg`/`ffprobe` (on PATH), Zod-first types, path aliases (`@/`).

---

## Verification note (read before starting)

This repo has **no automated test suite** — `CLAUDE.md` states this explicitly and it overrides the usual TDD-with-unit-tests flow. Do **not** add a test runner. Each task's verification gate is:

```bash
pnpm type-check    # tsc --noEmit — must pass
pnpm lint:check    # eslint src — must pass (no new errors)
```

Tasks that change runtime behavior also include a **manual verification** step using a real or synthetic input. Where a real TorBox source is unavailable, the plan gives an `ffmpeg`-generated local test file you can point the code at.

## Conventions to honor (from `.cursor/rules` / CLAUDE.md)

- **Zod-first:** define a Zod schema, derive the type with `z.infer`. Never `any`.
- `import type` for type-only imports; `readonly` for immutable fields.
- JSDoc every class, method, function, and type.
- Path aliases (`@/services/...`), never deep relative imports.
- Conventional commits: brief title, blank line, detailed body.

## File map

- **Modify** `src/types/index.ts` — add `MAX_SEGMENT_SIZE_MB`, `SEGMENT_SIZE_SAFETY_MARGIN`, `HLS_SEGMENT_DURATION_SECONDS` to `EnvConfigSchema`; add `ProcessingRouteSchema` / `ProcessingPlanSchema` + derived types.
- **Modify** `env.example` — document the three new env vars.
- **Create** `src/services/processingPlanner.ts` — probes source, predicts max segment size, returns a `ProcessingPlan`.
- **Modify** `src/services/encoding/EncodingStrategyFactory.ts` — real one-time hardware detection with libx264 as the guaranteed fallback; cache the result.
- **Modify** `src/services/encoding/NvidiaEncodingStrategy.ts` — capped-quality (CQ) instead of fixed CBR; remove the strategy-level keyframe flags (keyframe placement becomes the runner's single responsibility).
- **Modify** `src/services/videoProcessor.ts` — add a remux method, add a single fused PNG-wrap method, route via `ProcessingPlanner`, remove the dead "CPU fallback" `try/catch`, add a one-shot remux→transcode fallback on oversize segments, make the runner own keyframe placement.
- **Modify** `CLAUDE.md` — update the now-stale note that says the factory is stubbed / does not fall back.

---

## Task 1: Config — segment budget and safety margin

**Files:**
- Modify: `src/types/index.ts:7-25` (`EnvConfigSchema`)
- Modify: `env.example`

- [ ] **Step 1: Add the three env vars to `EnvConfigSchema`**

In `src/types/index.ts`, inside `EnvConfigSchema = z.object({ ... })`, add after the `TORBOX_TOKEN` line (keep the existing string→number transform pattern already used by `TIKTOK_BATCH_SIZE`):

```typescript
  MAX_SEGMENT_SIZE_MB: z
    .string()
    .transform(val => parseFloat(val))
    .pipe(z.number().positive())
    .default('5'),
  SEGMENT_SIZE_SAFETY_MARGIN: z
    .string()
    .transform(val => parseFloat(val))
    .pipe(z.number().positive().max(1))
    .default('0.8'),
  HLS_SEGMENT_DURATION_SECONDS: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .default('5'),
```

- [ ] **Step 2: Document them in `env.example`**

Add to `env.example`:

```bash
# Max size (MB) for a single HLS segment uploaded to the image CDN. Hard hosting limit.
MAX_SEGMENT_SIZE_MB=5
# Fraction of MAX_SEGMENT_SIZE_MB the remux predictor must stay under to choose copy (0-1).
SEGMENT_SIZE_SAFETY_MARGIN=0.8
# Target HLS segment duration (seconds) for the transcode route.
HLS_SEGMENT_DURATION_SECONDS=5
```

- [ ] **Step 3: Verify**

```bash
pnpm type-check
pnpm lint:check
```
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts env.example
git commit -m "feat(config): add segment-size budget and safety-margin env vars

Adds MAX_SEGMENT_SIZE_MB, SEGMENT_SIZE_SAFETY_MARGIN, and
HLS_SEGMENT_DURATION_SECONDS to EnvConfigSchema for the remux router and
transcode segmenter."
```

---

## Task 2: Types — ProcessingRoute and ProcessingPlan

**Files:**
- Modify: `src/types/index.ts` (after `EnvConfig` type export, around line 30)

- [ ] **Step 1: Add the Zod schemas and derived types**

In `src/types/index.ts`, after the `export type EnvConfig = ...` line:

```typescript
/**
 * Which processing route the planner selected for a source.
 * - `remux`: stream-copy (`-c copy`) into HLS — no re-encode, no GPU.
 * - `transcode`: re-encode through the encoder ladder.
 */
export const ProcessingRouteSchema = z.enum(['remux', 'transcode']);

/**
 * The route to take for a source.
 */
export type ProcessingRoute = z.infer<typeof ProcessingRouteSchema>;

/**
 * Schema for a processing plan produced by the ProcessingPlanner.
 */
export const ProcessingPlanSchema = z.object({
  /** Selected route. */
  route: ProcessingRouteSchema,
  /** Human-readable reason the route was chosen (for logs). */
  reason: z.string(),
  /** Predicted worst-case segment size in MB (undefined when probing failed). */
  predictedMaxSegmentMB: z.number().optional(),
});

/**
 * A processing plan: the route plus why it was chosen.
 */
export type ProcessingPlan = z.infer<typeof ProcessingPlanSchema>;
```

- [ ] **Step 2: Verify**

```bash
pnpm type-check
pnpm lint:check
```
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add ProcessingRoute and ProcessingPlan schemas

Zod-first route ('remux' | 'transcode') and plan object consumed by the
ProcessingPlanner and VideoProcessor."
```

---

## Task 3: ProcessingPlanner — probe and route decision

**Files:**
- Create: `src/services/processingPlanner.ts`

This service decides the route. It (a) reads bitrate from ffprobe metadata, (b) measures the largest keyframe gap over the **first 60 seconds** of the source (bounded so we never download a whole remote file just to plan), (c) predicts the worst-case segment size as `bitrate × maxKeyframeGap`, and (d) chooses `remux` only if that prediction stays under `MAX_SEGMENT_SIZE_MB × SEGMENT_SIZE_SAFETY_MARGIN`.

- [ ] **Step 1: Create the planner**

Create `src/services/processingPlanner.ts`:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '@/utils/logger';
import { envConfig } from '@/config';
import type { ProcessingPlan } from '@/types';

const execFileAsync = promisify(execFile);

/**
 * Decides whether a source can be remuxed (stream-copied) into HLS or must be
 * transcoded, based on a bounded probe of the source's bitrate and keyframe
 * spacing.
 */
export class ProcessingPlanner {
  /** Seconds of the source to sample when measuring keyframe spacing. */
  private readonly probeWindowSeconds = 60;

  /**
   * Builds a processing plan for a source URL.
   * @param sourceUrl The source video URL (e.g. a TorBox temporary URL).
   * @returns The selected route and the reasoning.
   */
  async plan(sourceUrl: string): Promise<ProcessingPlan> {
    try {
      const bitrateBps = await this.getVideoBitrateBps(sourceUrl);
      const maxKeyframeGapSeconds = await this.getMaxKeyframeGapSeconds(sourceUrl);

      // Worst-case segment: a remux can only cut at keyframes, so a segment can
      // span an entire keyframe gap at the source's bitrate.
      const predictedMaxSegmentBytes = (bitrateBps / 8) * maxKeyframeGapSeconds;
      const predictedMaxSegmentMB = predictedMaxSegmentBytes / (1024 * 1024);

      const budgetMB = envConfig.MAX_SEGMENT_SIZE_MB * envConfig.SEGMENT_SIZE_SAFETY_MARGIN;

      if (predictedMaxSegmentMB > 0 && predictedMaxSegmentMB <= budgetMB) {
        return {
          route: 'remux',
          reason:
            `predicted max segment ${predictedMaxSegmentMB.toFixed(2)}MB ` +
            `<= budget ${budgetMB.toFixed(2)}MB ` +
            `(bitrate ${(bitrateBps / 1_000_000).toFixed(2)}Mbps, ` +
            `max keyframe gap ${maxKeyframeGapSeconds.toFixed(2)}s)`,
          predictedMaxSegmentMB,
        };
      }

      return {
        route: 'transcode',
        reason:
          `predicted max segment ${predictedMaxSegmentMB.toFixed(2)}MB ` +
          `> budget ${budgetMB.toFixed(2)}MB — re-encode to fit`,
        predictedMaxSegmentMB,
      };
    } catch (error) {
      // Probing failed (unreachable URL, exotic container, etc.). Transcoding
      // always produces a valid result, so it is the safe default.
      logger.warn('⚠️ Planner probe failed; defaulting to transcode route:', error);
      return { route: 'transcode', reason: 'probe failed — defaulting to transcode' };
    }
  }

  /**
   * Reads the video stream's bitrate (bps). Falls back to the container bitrate,
   * then to a resolution-based estimate.
   * @param sourceUrl The source URL.
   */
  private async getVideoBitrateBps(sourceUrl: string): Promise<number> {
    const metadata = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
      ffmpeg.ffprobe(sourceUrl, (err, data) => (err ? reject(err) : resolve(data)));
    });

    const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
    const streamBitrate = videoStream?.bit_rate ? parseInt(videoStream.bit_rate, 10) : 0;
    if (streamBitrate > 0) return streamBitrate;

    const formatBitrate = metadata.format?.bit_rate
      ? parseInt(String(metadata.format.bit_rate), 10)
      : 0;
    if (formatBitrate > 0) return formatBitrate;

    // Resolution-based estimate (matches IntelQsvEncodingStrategy's table).
    const width = videoStream?.width ?? 1920;
    if (width >= 3840) return 120_000_000;
    if (width >= 1920) return 40_000_000;
    if (width >= 1280) return 20_000_000;
    return 8_000_000;
  }

  /**
   * Measures the largest gap (seconds) between consecutive keyframes in the
   * first `probeWindowSeconds` of the source. Uses ffprobe packet flags, bounded
   * by `-read_intervals` so remote sources are not fully downloaded.
   * @param sourceUrl The source URL.
   */
  private async getMaxKeyframeGapSeconds(sourceUrl: string): Promise<number> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-read_intervals',
      `%+${this.probeWindowSeconds}`,
      '-show_entries',
      'packet=pts_time,flags',
      '-of',
      'csv=print_section=0',
      sourceUrl,
    ]);

    const keyframeTimes: number[] = [];
    for (const line of stdout.split('\n')) {
      const [ptsTime, flags] = line.split(',');
      if (!ptsTime || !flags) continue;
      // Keyframe packets carry the 'K' flag (e.g. "K_" or "K__").
      if (flags.includes('K')) {
        const t = parseFloat(ptsTime);
        if (!Number.isNaN(t)) keyframeTimes.push(t);
      }
    }

    if (keyframeTimes.length < 2) {
      // Too few keyframes sampled to trust — report a large gap so the caller
      // routes to transcode rather than risk an oversize remux segment.
      return Number.POSITIVE_INFINITY;
    }

    keyframeTimes.sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < keyframeTimes.length; i++) {
      const gap = keyframeTimes[i]! - keyframeTimes[i - 1]!;
      if (gap > maxGap) maxGap = gap;
    }
    return maxGap;
  }
}
```

- [ ] **Step 2: Verify**

```bash
pnpm type-check
pnpm lint:check
```
Expected: both pass.

- [ ] **Step 3: Manual smoke test of the planner**

Create a short local H.264 file with a known 2 s keyframe interval and probe it through a throwaway script:

```bash
ffmpeg -y -f lavfi -i testsrc=duration=20:size=1280x720:rate=30 \
  -c:v libx264 -g 60 -keyint_min 60 -sc_threshold 0 -b:v 2M /tmp/plan-test.mp4
```

Then add a temporary scratch file `src/scratch-plan.ts` (delete after):

```typescript
import { ProcessingPlanner } from '@/services/processingPlanner';
new ProcessingPlanner().plan('/tmp/plan-test.mp4').then(p => {
  // eslint-disable-next-line no-console
  console.log(p);
});
```

Run: `pnpm dev` is for the app, so run the scratch directly:
```bash
npx ts-node -r tsconfig-paths/register src/scratch-plan.ts
```
Expected: prints `{ route: 'remux', reason: '...', predictedMaxSegmentMB: <~0.5> }` (2 Mbps × ~2 s ≈ 0.5 MB, well under 4 MB budget). Then delete the scratch file:
```bash
rm src/scratch-plan.ts
```

> If `tsconfig-paths` is not wired for ad-hoc scripts, instead temporarily import and call the planner from `src/index.ts`, run `pnpm dev`, observe the log, and revert. The point is only to confirm the route decision prints correctly.

- [ ] **Step 4: Commit**

```bash
git add src/services/processingPlanner.ts
git commit -m "feat(processing): add ProcessingPlanner route decision

Probes source bitrate and max keyframe gap (bounded to the first 60s) to
predict worst-case remux segment size; chooses remux when it fits the
budget, else transcode. Falls back to transcode on any probe failure."
```

---

## Task 4: Real encoder detection in the factory

**Files:**
- Modify: `src/services/encoding/EncodingStrategyFactory.ts` (replace whole file)

`createStrategy()` must detect the best available encoder **once** and cache it. libx264 (`CpuEncodingStrategy`) is the guaranteed terminal fallback so a CPU-only box always works.

- [ ] **Step 1: Rewrite the factory with cached detection**

Replace the entire contents of `src/services/encoding/EncodingStrategyFactory.ts`:

```typescript
import { logger } from '@/utils/logger';
import type { EncodingStrategy } from '@/services/encoding/EncodingStrategy';
import { NvidiaEncodingStrategy } from '@/services/encoding/NvidiaEncodingStrategy';
import { IntelQsvEncodingStrategy } from '@/services/encoding/IntelQsvEncodingStrategy';
import { CpuEncodingStrategy } from '@/services/encoding/CpuEncodingStrategy';

/**
 * Factory that selects the best available encoding strategy for the current
 * machine. Detection runs once and is cached for the process lifetime.
 */
export class EncodingStrategyFactory {
  /** Cached winner of the one-time hardware probe. */
  private static cachedStrategy: EncodingStrategy | null = null;

  /**
   * Candidate strategies in priority order. The last entry (libx264) is always
   * available, guaranteeing a working encoder on any host.
   */
  private static candidates(): EncodingStrategy[] {
    return [
      new NvidiaEncodingStrategy('p4'),
      new IntelQsvEncodingStrategy('fast'),
      new CpuEncodingStrategy('medium'),
    ];
  }

  /**
   * Returns the best available encoding strategy, detecting hardware once and
   * caching the result.
   * @returns The selected strategy.
   */
  static async createStrategy(): Promise<EncodingStrategy> {
    if (this.cachedStrategy) return this.cachedStrategy;

    for (const candidate of this.candidates()) {
      // eslint-disable-next-line no-await-in-loop
      const available = await candidate.isAvailable();
      if (available) {
        logger.info(`🚀 Selected encoding strategy: ${candidate.getName()}`);
        this.cachedStrategy = candidate;
        return candidate;
      }
      logger.debug(`Encoder not available, trying next: ${candidate.getName()}`);
    }

    // Unreachable in practice: CpuEncodingStrategy.isAvailable() is the floor.
    const fallback = new CpuEncodingStrategy('medium');
    logger.warn('⚠️ No encoder probe succeeded; forcing libx264 fallback');
    this.cachedStrategy = fallback;
    return fallback;
  }

  /**
   * Returns every available strategy (probed live; not cached). For diagnostics.
   * @returns The available strategies.
   */
  static async getAvailableStrategies(): Promise<EncodingStrategy[]> {
    const available: EncodingStrategy[] = [];
    for (const candidate of this.candidates()) {
      // eslint-disable-next-line no-await-in-loop
      if (await candidate.isAvailable()) available.push(candidate);
    }
    return available;
  }

  /**
   * Returns strategy info for debugging/logging.
   * @returns Available strategy names and the recommended one.
   */
  static async getStrategyInfo(): Promise<{
    availableStrategies: string[];
    recommendedStrategy: string;
  }> {
    const availableStrategies = await this.getAvailableStrategies();
    const recommendedStrategy = await this.createStrategy();
    return {
      availableStrategies: availableStrategies.map(s => s.getName()),
      recommendedStrategy: recommendedStrategy.getName(),
    };
  }
}
```

- [ ] **Step 2: Verify**

```bash
pnpm type-check
pnpm lint:check
```
Expected: both pass.

- [ ] **Step 3: Manual verification of selection**

On the dev machine (RTX 4060 Ti), confirm NVENC is selected; with NVENC hidden, confirm libx264 is selected. Temporary scratch `src/scratch-detect.ts` (delete after):

```typescript
import { EncodingStrategyFactory } from '@/services/encoding/EncodingStrategyFactory';
EncodingStrategyFactory.getStrategyInfo().then(info => {
  // eslint-disable-next-line no-console
  console.log(info);
});
```

```bash
npx ts-node -r tsconfig-paths/register src/scratch-detect.ts
# Expected on the 4060 Ti: recommendedStrategy: 'NVIDIA NVENC'
rm src/scratch-detect.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/services/encoding/EncodingStrategyFactory.ts
git commit -m "feat(encoding): real one-time encoder detection with libx264 floor

Probes NVENC -> Intel QSV -> libx264 once and caches the winner, so the
same binary runs on a GPU box or a CPU-only server instead of hard-failing
without NVENC."
```

---

## Task 5: NVENC capped-quality + remove conflicting keyframe flags

**Files:**
- Modify: `src/services/encoding/NvidiaEncodingStrategy.ts:38-87` (`getOptions`)

Two changes: (1) switch the fixed CBR 10 Mbps to capped-quality VBR (`-rc vbr -cq` with a `-maxrate` ceiling) so modest sources are not inflated; (2) remove `-g`, `-keyint_min`, `-sc_threshold`, and `-force_key_frames` from the strategy — keyframe placement becomes the runner's single responsibility (Task 7), eliminating today's `-g 30` vs `-g 150` conflict.

- [ ] **Step 1: Replace `getOptions`**

In `src/services/encoding/NvidiaEncodingStrategy.ts`, replace the `getOptions` method body:

```typescript
  getOptions(metadata: ffmpeg.FfprobeData): string[] {
    // Ceiling so a high-bitrate source cannot blow the per-segment budget;
    // capped VBR keeps modest sources small while staying visually identical.
    const maxBitrateKbps = 10_000;

    const width = metadata.streams?.[0]?.width || 1920;
    const height = metadata.streams?.[0]?.height || 1080;

    let scaleFilter = '';
    if (width > 1920 || height > 1080) {
      scaleFilter = `scale=1920:1080:force_original_aspect_ratio=decrease`;
      logger.info(`📐 Scaling video from ${width}x${height} to 1080p`);
    }

    const options = [
      '-c:v',
      'h264_nvenc',
      '-preset',
      this.preset,
      '-rc',
      'vbr',
      '-cq',
      '23',
      '-maxrate',
      `${maxBitrateKbps}k`,
      '-bufsize',
      `${maxBitrateKbps * 2}k`,
      // NOTE: keyframe placement (-g / -force_key_frames) is owned by
      // VideoProcessor.runFFmpegConversion so segments align to segment
      // boundaries. Do not set it here.
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-ac',
      '2',
    ];

    if (scaleFilter) {
      options.push('-vf', scaleFilter);
    }

    return options;
  }
```

- [ ] **Step 2: Verify**

```bash
pnpm type-check
pnpm lint:check
```
Expected: both pass. (`targetBitrateKbps` is gone; confirm no lint "unused var".)

- [ ] **Step 3: Commit**

```bash
git add src/services/encoding/NvidiaEncodingStrategy.ts
git commit -m "feat(encoding): NVENC capped-quality VBR, drop strategy keyframe flags

Replaces fixed CBR 10Mbps with capped VBR (cq 23, maxrate 10Mbps) so modest
sources are not inflated. Removes -g/-keyint_min/-force_key_frames from the
strategy; keyframe placement now lives solely in runFFmpegConversion,
ending the -g 30 vs -g 150 conflict."
```

---

## Task 6: VideoProcessor — add remux + fused PNG-wrap methods

**Files:**
- Modify: `src/services/videoProcessor.ts` (add two new private methods; nothing wired yet)

Add the building blocks first; Task 7 wires them into `processVideo`.

- [ ] **Step 1: Add the remux method**

In `src/services/videoProcessor.ts`, add this private method (place it next to `runFFmpegConversion`):

```typescript
  /**
   * Remuxes (stream-copies) the source into HLS without re-encoding. Segments
   * are cut at the source's keyframes, so durations are >= the target and the
   * `<5MB` budget is verified afterward by the caller.
   * @param inputPath Source video URL/path.
   * @param outputDir Output directory.
   */
  private async runRemuxToHls(inputPath: string, outputDir: string): Promise<void> {
    const playlistPath = path.join(outputDir, 'playlist.m3u8');
    const segmentPattern = path.join(outputDir, 'segment_%03d.ts');
    const segmentDuration = envConfig.HLS_SEGMENT_DURATION_SECONDS;

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c',
          'copy',
          '-f',
          'hls',
          '-hls_time',
          segmentDuration.toString(),
          '-hls_list_size',
          '0',
          '-hls_segment_filename',
          segmentPattern,
          '-hls_flags',
          'independent_segments',
        ])
        .output(playlistPath)
        .on('start', () => logger.info('🚀 Starting HLS remux (stream copy)'))
        .on('end', () => {
          logger.info('✅ HLS remux completed');
          resolve();
        })
        .on('error', (error, stdout, stderr) => {
          logger.error('❌ HLS remux failed:', {
            error: error.message,
            stdout: stdout || 'No stdout',
            stderr: stderr || 'No stderr',
          });
          reject(error);
        })
        .run();
    });
  }
```

- [ ] **Step 2: Add the fused PNG-wrap method**

Add this private method. It replaces `removeFFmpegMetadataFromTsSegments` + `embedSegmentsToPng` + `cleanupTsFiles` with one read/transform/write per segment. Reuse the existing single-segment metadata-strip and PNG-embed logic by factoring the byte work into helpers used here.

```typescript
  /**
   * Strips FFmpeg metadata and wraps each `.ts` segment into a `.png` in a single
   * pass, then removes the `.ts`. Replaces the former three separate passes.
   * @param outputDir Directory containing the `.ts` segments.
   */
  private async wrapSegmentsInPng(outputDir: string): Promise<void> {
    logger.info('🖼️ Stripping metadata and wrapping segments into PNG (single pass)...');

    const files = await fs.readdir(outputDir);
    const tsFiles = files.filter(file => file.endsWith('.ts') && file.startsWith('segment_'));
    logger.info(`Found ${tsFiles.length} TS segment files to wrap`);

    // 1x1 transparent PNG used as the carrier; payload is appended after IEND.
    const carrierPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );

    for (const tsFile of tsFiles) {
      const tsPath = path.join(outputDir, tsFile);
      const pngPath = path.join(outputDir, tsFile.replace('.ts', '.png'));

      try {
        const raw = await fs.readFile(tsPath);
        const cleaned = this.stripFFmpegMetadata(raw);
        await fs.writeFile(pngPath, Buffer.concat([carrierPng, cleaned]));
        await fs.unlink(tsPath);
      } catch (error) {
        logger.error(`❌ Failed to wrap ${tsFile} into PNG:`, error);
        throw error;
      }
    }

    logger.info(`✅ Wrapped ${tsFiles.length} segments into PNG files`);
  }

  /**
   * Returns segment bytes with FFmpeg's first-packet metadata removed. If no
   * metadata marker is present (common for remuxed segments), returns the input
   * unchanged.
   * @param segmentData Raw `.ts` bytes.
   */
  private stripFFmpegMetadata(segmentData: Buffer): Buffer {
    const ffmpegStart = segmentData.indexOf(Buffer.from('FFmpeg'));
    if (ffmpegStart === -1) return segmentData;

    const packetHeader = segmentData.subarray(0, ffmpegStart - 6);
    let nextSyncByte = 188;
    while (nextSyncByte < segmentData.length && segmentData[nextSyncByte] !== 0x47) {
      nextSyncByte++;
    }
    if (nextSyncByte >= segmentData.length) return segmentData;

    return Buffer.concat([packetHeader, segmentData.subarray(nextSyncByte)]);
  }
```

> The byte-surgery in `stripFFmpegMetadata` is lifted verbatim from the old `removeFFmpegMetadataFromTsSegments` loop body (the `0x47` sync-byte scan and `ffmpegStart - 6` header split). The PNG carrier and append are lifted from `embedSegmentInPng`. The `IEND` boundary contract is unchanged, so the orchestrator's extraction side still works.

- [ ] **Step 3: Add the missing `envConfig` import**

At the top of `src/services/videoProcessor.ts`, add (if not already present):

```typescript
import { envConfig } from '@/config';
```

- [ ] **Step 4: Verify**

```bash
pnpm type-check
pnpm lint:check
```
Expected: both pass. The new methods are unused for now — that's fine; they get wired in Task 7. If lint flags them as unused, proceed directly to Task 7 in the same working session before committing, OR add them and Task 7's wiring in one commit. To keep commits clean, commit Task 6 + Task 7 together if the linter is strict about unused privates.

- [ ] **Step 5: Commit (or defer to Task 7 — see note above)**

```bash
git add src/services/videoProcessor.ts
git commit -m "feat(processing): add HLS remux and single-pass PNG wrap helpers

runRemuxToHls stream-copies into HLS; wrapSegmentsInPng fuses the former
metadata-strip + PNG-embed + cleanup into one read/write per segment. Not
yet wired into processVideo."
```

---

## Task 7: VideoProcessor — route, fallback, and keyframe ownership

**Files:**
- Modify: `src/services/videoProcessor.ts` — `processVideo` (lines ~20-93), `convertVideoToHLS` (lines ~101-145), `runFFmpegConversion` (lines ~154-202)
- Remove: `removeFFmpegMetadataFromTsSegments`, `embedSegmentsToPng`, `embedSegmentInPng`, `cleanupTsFiles` (replaced by Task 6 helpers)

- [ ] **Step 1: Make the runner own keyframe placement**

In `runFFmpegConversion`, the `outputOptions` currently set both `-force_key_frames` and `-g` (and the strategy used to too). Standardize to a single authoritative block. Replace the `.outputOptions([...])` array with:

```typescript
        .outputOptions([
          ...encodingOptions,
          '-f',
          'hls',
          '-hls_time',
          segmentDuration.toString(),
          '-hls_list_size',
          '0',
          '-hls_segment_filename',
          segmentPattern,
          '-force_key_frames',
          `expr:gte(t,n_forced*${segmentDuration})`,
          '-g',
          Math.round(segmentDuration * 30).toString(),
          '-keyint_min',
          Math.round(segmentDuration * 30).toString(),
          '-sc_threshold',
          '0',
          '-hls_flags',
          'independent_segments',
        ])
```

This is the only place keyframes are set now (Task 5 removed them from the NVENC strategy).

- [ ] **Step 2: Remove the dead CPU-fallback `try/catch`**

Replace the whole `convertVideoToHLS` method body so it no longer re-creates the same strategy in a fake fallback:

```typescript
  private async convertVideoToHLS(inputPath: string, outputDir: string): Promise<string> {
    const playlistPath = path.join(outputDir, 'playlist.m3u8');

    const metadata = await this.getVideoMetadata(inputPath);
    const ffmpegMetadata = await this.getFFmpegMetadata(inputPath);
    const segmentDuration = this.calculateSegmentDuration();

    const encodingStrategy = await EncodingStrategyFactory.createStrategy();
    const encodingOptions = encodingStrategy.getOptions(ffmpegMetadata);

    logger.info(`🚀 Using encoding strategy: ${encodingStrategy.getName()}`);
    logger.info(`📊 File size: ${metadata.fileSizeMB.toFixed(2)} MB`);
    logger.info(`⏱️ Video duration: ${metadata.durationSeconds.toFixed(2)} seconds`);
    logger.info(`🎯 Segment duration: ${segmentDuration.toFixed(2)} seconds`);

    await this.runFFmpegConversion(inputPath, outputDir, segmentDuration, encodingOptions);
    return playlistPath;
  }
```

(Real fallback now lives in `EncodingStrategyFactory` from Task 4.)

- [ ] **Step 3: Add a planner field and route in `processVideo`**

At the top of the class, add the planner field:

```typescript
  private readonly planner = new ProcessingPlanner();
```

And add the import at the top of the file:

```typescript
import { ProcessingPlanner } from '@/services/processingPlanner';
```

Then in `processVideo`, replace Steps 2–7 (the `convertVideoToHLS` call through `cleanupTsFiles`) with the routed flow:

```typescript
      // Step 2: Decide route (remux vs transcode)
      const planStartTime = Date.now();
      const plan = await this.planner.plan(videoUrl);
      logger.info(`🧭 Route: ${plan.route} — ${plan.reason}`);
      stepTimings['planning'] = Date.now() - planStartTime;

      // Step 3: Produce HLS .ts segments via the chosen route
      const hlsStartTime = Date.now();
      if (plan.route === 'remux') {
        await this.runRemuxToHls(videoUrl, outputDir);

        // Hard re-check: if the predictor was wrong and a segment is over budget,
        // fall back to a transcode once.
        const oversized = await this.validateSegmentSizes(outputDir);
        if (oversized.length > 0) {
          logger.warn(
            `⚠️ Remux produced ${oversized.length} oversize segment(s); ` +
              `falling back to transcode`
          );
          await this.clearTsAndPlaylist(outputDir);
          await this.convertVideoToHLS(videoUrl, outputDir);
        }
      } else {
        await this.convertVideoToHLS(videoUrl, outputDir);
      }
      stepTimings['hls_conversion'] = Date.now() - hlsStartTime;

      // Step 4: Strip metadata + wrap segments into PNG (single pass)
      const wrapStartTime = Date.now();
      await this.wrapSegmentsInPng(outputDir);
      stepTimings['png_wrap'] = Date.now() - wrapStartTime;

      // Step 5: Update playlist to reference PNG files
      const playlistUpdateStartTime = Date.now();
      await this.updatePlaylistToUsePng(outputDir);
      stepTimings['playlist_update'] = Date.now() - playlistUpdateStartTime;

      // Step 6: Embed M3U8 playlist into PNG file
      const playlistEmbedStartTime = Date.now();
      await this.embedPlaylistToPng(outputDir);
      stepTimings['playlist_embedding'] = Date.now() - playlistEmbedStartTime;

      // Step 7: Validate the conversion
      const validationStartTime = Date.now();
      await this.validateConversion(outputDir);
      stepTimings['validation'] = Date.now() - validationStartTime;
```

- [ ] **Step 4: Add the small helper used by the fallback**

Add this private method (clears the remux output before re-running as transcode):

```typescript
  /**
   * Removes `.ts` segments and the working playlist so a route can be re-run.
   * @param outputDir Directory to clear.
   */
  private async clearTsAndPlaylist(outputDir: string): Promise<void> {
    const files = await fs.readdir(outputDir);
    await Promise.all(
      files
        .filter(f => f.endsWith('.ts') || f === 'playlist.m3u8')
        .map(f => fs.unlink(path.join(outputDir, f)).catch(() => undefined))
    );
  }
```

- [ ] **Step 5: Delete the now-unused methods**

Remove these methods entirely from `src/services/videoProcessor.ts` (replaced by Task 6 helpers): `removeFFmpegMetadataFromTsSegments`, `embedSegmentsToPng`, `embedSegmentInPng`, and `cleanupTsFiles`. Keep `embedPlaylistToPng` but change it to use the carrier inline (it previously called `embedSegmentInPng`). Replace `embedPlaylistToPng`'s body:

```typescript
  private async embedPlaylistToPng(outputDir: string): Promise<void> {
    logger.info('📄 Embedding M3U8 playlist into PNG file...');
    const playlistPath = path.join(outputDir, 'playlist.m3u8');
    const playlistPngPath = path.join(outputDir, 'playlist.png');

    const carrierPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );

    try {
      const playlistData = await fs.readFile(playlistPath);
      await fs.writeFile(playlistPngPath, Buffer.concat([carrierPng, playlistData]));
      await fs.unlink(playlistPath);
      logger.info('✅ Successfully embedded M3U8 playlist into PNG file');
    } catch (error) {
      logger.error('❌ Failed to embed M3U8 playlist into PNG:', error);
      throw error;
    }
  }
```

> The base64 carrier is duplicated in `wrapSegmentsInPng` and `embedPlaylistToPng`. If you prefer DRY, lift it to a `private static readonly CARRIER_PNG_BASE64` on the class and decode it in both. Either is acceptable; do not over-engineer.

- [ ] **Step 6: Verify**

```bash
pnpm type-check
pnpm lint:check
```
Expected: both pass, no unused-method warnings (the deleted methods are gone; the Task 6 helpers are now used).

- [ ] **Step 7: Manual end-to-end on a local remux-eligible file**

```bash
# 2 Mbps, 2s GOP, 720p, 20s -> should route REMUX and produce <5MB segments
ffmpeg -y -f lavfi -i testsrc=duration=20:size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440:duration=20 \
  -c:v libx264 -g 60 -keyint_min 60 -sc_threshold 0 -b:v 2M -c:a aac /tmp/remux-test.mp4
```

Point the processor at it via a scratch run (temporary `src/scratch-process.ts`, delete after):

```typescript
import { VideoProcessor } from '@/services/videoProcessor';
new VideoProcessor()
  .processVideo('/tmp/remux-test.mp4', 'scratch-remux')
  // eslint-disable-next-line no-console
  .then(() => console.log('done'));
```

```bash
npx ts-node -r tsconfig-paths/register --expose-gc src/scratch-process.ts
```
Expected logs: `🧭 Route: remux`, then PNG wrap, then validation passes. Inspect output:
```bash
ls -la processed/scratch-remux/*.png   # segment_*.png + playlist.png, each < 5MB
```
Confirm a segment PNG still extracts (the orchestrator's contract): the bytes after the `IEND` marker (`49 45 4E 44 AE 42 60 82`) must be a valid TS payload. Then clean up:
```bash
rm -rf processed/scratch-remux src/scratch-process.ts
```

- [ ] **Step 8: Manual end-to-end on a transcode-forced file**

```bash
# Long GOP + high bitrate -> predicted segment > budget -> route TRANSCODE
ffmpeg -y -f lavfi -i testsrc=duration=20:size=1920x1080:rate=30 \
  -c:v libx264 -g 600 -keyint_min 600 -sc_threshold 0 -b:v 40M /tmp/transcode-test.mp4
```
Re-run the scratch with this path and `scratch-transcode`. Expected: `🧭 Route: transcode`, the selected encoder logged (NVENC on the 4060 Ti), segments < 5 MB, validation passes. Clean up the scratch dir/file.

- [ ] **Step 9: Commit**

```bash
git add src/services/videoProcessor.ts
git commit -m "feat(processing): route remux vs transcode, fuse PNG wrap, fix keyframes

processVideo now plans the route (remux when segments fit, else transcode),
re-checks remux segment sizes with a one-shot transcode fallback, and uses
the single-pass PNG wrap. Keyframe placement is owned solely by
runFFmpegConversion. Removes the dead CPU-fallback try/catch and the three
superseded post-encode passes."
```

---

## Task 8: Update stale CLAUDE.md note

**Files:**
- Modify: `CLAUDE.md` (the "Encoding strategies" paragraph)

- [ ] **Step 1: Correct the architecture note**

In `CLAUDE.md`, replace the paragraph that begins "A Strategy + Factory pattern exists..." and claims the factory "currently always returns `NvidiaEncodingStrategy('p1')`" and "does not actually fall back" with:

```markdown
### Encoding strategies (`src/services/encoding/`)

A Strategy + Factory pattern selects the encoder. `EncodingStrategyFactory.createStrategy()` probes the host **once** (cached) in priority order **NVENC → Intel QSV → libx264** and returns the first available; libx264 is the guaranteed fallback, so the same binary runs on a GPU box or a CPU-only server. Keyframe placement is owned solely by `VideoProcessor.runFFmpegConversion` (not the strategies), and NVENC uses capped-quality VBR rather than fixed CBR.

Before encoding, `ProcessingPlanner` probes the source and routes it: **remux** (`-c copy`, no re-encode) when the predicted worst-case segment stays under `MAX_SEGMENT_SIZE_MB × SEGMENT_SIZE_SAFETY_MARGIN`, otherwise **transcode**. A remux that unexpectedly produces an oversize segment falls back to a one-shot transcode.
```

- [ ] **Step 2: Verify (docs only)**

```bash
pnpm lint:check
```
Expected: passes (no source changes).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update encoding/processing architecture note

Factory now does real cached detection with a libx264 floor; processing
routes remux vs transcode. Removes the stale 'always NVENC / no fallback'
description."
```

---

## Self-review (completed by plan author)

**Spec coverage:**
- Probe-and-route decision → Task 3 (planner) + Task 7 (wiring). ✓
- Segment-size guard as the only gate → Task 3 prediction + Task 1 budget config. ✓
- REMUX route (`-c copy`) → Task 6 `runRemuxToHls`. ✓
- Post-condition re-check + one-shot transcode fallback → Task 7 Step 3. ✓
- Encoder ladder with real detection + libx264 floor → Task 4. ✓
- Detection once at startup, cached → Task 4 `cachedStrategy`. ✓
- Capped-quality instead of CBR 10 Mbps → Task 5. ✓
- Fix conflicting keyframe flags (single source of truth) → Task 5 (remove from strategy) + Task 7 Step 1 (runner owns it). ✓
- Fused single-pass post-processing → Task 6 `wrapSegmentsInPng` + Task 7 deletions. ✓
- IEND boundary contract preserved → Task 6 note (carrier + append unchanged). ✓
- Remove dead CPU-fallback try/catch → Task 7 Step 2. ✓
- Stale CLAUDE.md note → Task 8. ✓

**Type consistency:** `ProcessingPlan` shape (`route`, `reason`, `predictedMaxSegmentMB`) defined in Task 2 and consumed identically in Tasks 3 and 7. `EncodingStrategy` interface methods (`getName`, `isAvailable`, `getOptions`) used consistently in Task 4. `envConfig.MAX_SEGMENT_SIZE_MB` / `SEGMENT_SIZE_SAFETY_MARGIN` / `HLS_SEGMENT_DURATION_SECONDS` defined in Task 1, used in Tasks 3 and 6. New `VideoProcessor` methods (`runRemuxToHls`, `wrapSegmentsInPng`, `stripFFmpegMetadata`, `clearTsAndPlaylist`) defined in Tasks 6–7 and referenced consistently.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Manual verification steps give concrete `ffmpeg` commands and expected output.
