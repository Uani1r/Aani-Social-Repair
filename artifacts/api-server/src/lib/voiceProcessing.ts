// تحويل تسجيلات الدردشة الصوتية إلى M4A/AAC أحادي القناة على الخادم عبر FFmpeg.
//
// السبب: تحويل الصوت داخل المتصفح (mediabunny/WebCodecs) يستهلك المعالج
// والبطارية على iPhone Safari. هنا يُرفع التسجيل الخام كما سجّله الجهاز،
// ويتولى الخادم التحويل ثم يتحقق من الملف الناتج قبل أي رفع إلى ImageKit.
//
// المواصفة المستهدفة: AAC، أحادي القناة، 24kHz، ~17kbps، faststart.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** أقصى حجم لتسجيل خام واحد (12MiB تكفي ساعات من Opus منخفض المعدل). */
export const VOICE_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
export const VOICE_TARGET_SAMPLE_RATE = 24_000;
export const VOICE_TARGET_BITRATE = "17k";
export const VOICE_PROCESSING_TIMEOUT_MS = 60_000;
export const VOICE_PROBE_TIMEOUT_MS = 15_000;

export class VoiceProcessingError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "VoiceProcessingError";
    this.statusCode = statusCode;
  }
}

/** صيغ المصدر المقبولة (ما يسجّله Safari/Chrome فعلياً). */
const SOURCE_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export function voiceSourceExtension(mimeType: string): string | null {
  const normalized = (mimeType || "").split(";")[0].trim().toLowerCase();
  return SOURCE_EXTENSIONS[normalized] ?? null;
}

/** وسائط ffmpeg للتحويل إلى M4A متوافق: mono + 24kHz + AAC ~17kbps + faststart. */
export function buildVoiceFfmpegArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i", inputPath,
    // صوت فقط، بلا فيديو ولا بيانات وصفية من الجهاز
    "-vn",
    "-map_metadata", "-1",
    "-ac", "1",
    "-ar", String(VOICE_TARGET_SAMPLE_RATE),
    "-c:a", "aac",
    "-b:a", VOICE_TARGET_BITRATE,
    "-movflags", "+faststart",
    "-f", "mp4",
    outputPath,
  ];
}

export function buildVoiceFfprobeArgs(inputPath: string): string[] {
  return [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries",
    "stream=codec_name,channels,sample_rate,bit_rate:format=duration,size,bit_rate",
    "-of", "json",
    inputPath,
  ];
}

export interface VoiceProbeResult {
  codec: string;
  channels: number;
  sampleRate: number;
  bitRate: number;
  durationSeconds: number;
  sizeBytes: number;
}

function readNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** يحلّل مخرجات ffprobe JSON لملف صوتي واحد. */
export function parseVoiceFfprobeOutput(raw: string, fallbackSizeBytes = 0): VoiceProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VoiceProcessingError(422, "Could not read the converted audio metadata.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new VoiceProcessingError(422, "Could not read the converted audio metadata.");
  }

  const record = parsed as { streams?: unknown; format?: unknown };
  const streams = Array.isArray(record.streams) ? record.streams : [];
  const stream = streams.find((entry): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry));
  if (!stream) {
    throw new VoiceProcessingError(422, "The converted audio has no audio stream.");
  }

  const format = typeof record.format === "object" && record.format !== null && !Array.isArray(record.format)
    ? record.format as Record<string, unknown>
    : {};

  return {
    codec: typeof stream.codec_name === "string" ? stream.codec_name : "",
    channels: readNumber(stream.channels),
    sampleRate: readNumber(stream.sample_rate),
    bitRate: readNumber(stream.bit_rate),
    durationSeconds: readNumber(format.duration),
    sizeBytes: readNumber(format.size) || fallbackSizeBytes,
  };
}

/**
 * التحقق من الملف الناتج قبل رفعه: AAC، أحادي، ومدة موجبة. فشل أي شرط يعني
 * عدم رفع أي ملف وعدم حذف الأصل في جهة العميل.
 */
export function verifyVoiceM4aOutput(probe: VoiceProbeResult): void {
  if (!probe.codec || probe.codec.toLowerCase() !== "aac") {
    throw new VoiceProcessingError(422, `Expected an AAC track, got "${probe.codec || "none"}".`);
  }
  if (probe.channels !== 1) {
    throw new VoiceProcessingError(422, `Expected a mono track, got ${probe.channels || 0} channel(s).`);
  }
  if (!(probe.durationSeconds > 0)) {
    throw new VoiceProcessingError(422, "The converted audio has no measurable duration.");
  }
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runVoiceProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  const executable = command === "ffprobe"
    ? (process.env["FFPROBE_PATH"] || "ffprobe")
    : (process.env["FFMPEG_PATH"] || "ffmpeg");

  return new Promise<ProcessResult>(resolve => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", chunk => {
      stdout += String(chunk);
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });
    child.stderr?.on("data", chunk => {
      stderr += String(chunk);
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
    });
    child.on("error", error => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export interface VoiceTranscodeResult {
  bytes: Buffer;
  probe: VoiceProbeResult;
  processingMs: number;
}

/**
 * يحوّل تسجيلاً خاماً إلى M4A/AAC ويتحقق منه. ملفات العمل مؤقتة وتُحذف دائماً؛
 * أصل المستخدم يبقى في جهازه حتى ينجح الرفع.
 */
export async function transcodeVoiceToM4a(input: {
  bytes: Buffer;
  sourceMimeType: string;
}): Promise<VoiceTranscodeResult> {
  const extension = voiceSourceExtension(input.sourceMimeType);
  if (!extension) {
    throw new VoiceProcessingError(415, `Unsupported audio type "${input.sourceMimeType || "unknown"}".`);
  }
  if (!input.bytes || input.bytes.byteLength === 0) {
    throw new VoiceProcessingError(400, "The recording is empty.");
  }
  if (input.bytes.byteLength > VOICE_MAX_SOURCE_BYTES) {
    throw new VoiceProcessingError(413, "The recording exceeds the server audio limit.");
  }

  const startedAt = Date.now();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "aani-voice-"));

  try {
    const inputPath = path.join(workDir, `input.${extension}`);
    const outputPath = path.join(workDir, "output.m4a");
    await fs.writeFile(inputPath, input.bytes);

    const encode = await runVoiceProcess("ffmpeg", buildVoiceFfmpegArgs(inputPath, outputPath), VOICE_PROCESSING_TIMEOUT_MS);
    if (encode.timedOut) throw new VoiceProcessingError(504, "Audio transcoding timed out.");
    if (encode.code !== 0) {
      throw new VoiceProcessingError(422, `FFmpeg could not convert this recording${encode.stderr ? `: ${encode.stderr.slice(-300)}` : "."}`);
    }

    const stats = await fs.stat(outputPath).catch(() => null);
    if (!stats || stats.size <= 0) {
      throw new VoiceProcessingError(422, "The converted audio file is empty.");
    }

    const probeRun = await runVoiceProcess("ffprobe", buildVoiceFfprobeArgs(outputPath), VOICE_PROBE_TIMEOUT_MS);
    if (probeRun.timedOut || probeRun.code !== 0) {
      throw new VoiceProcessingError(422, "Could not verify the converted audio file.");
    }

    const probe = parseVoiceFfprobeOutput(probeRun.stdout, stats.size);
    verifyVoiceM4aOutput(probe);

    const bytes = await fs.readFile(outputPath);
    return { bytes, probe, processingMs: Date.now() - startedAt };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
