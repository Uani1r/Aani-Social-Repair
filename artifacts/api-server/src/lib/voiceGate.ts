// بوابة نقطة تحويل الصوت: المصادقة أولاً، ثم الحدود، ثم استقبال جسم الملف.
//
// ترتيب الوسائط في mediaVoice.ts هو: مصادقة/حدود → express.raw → المعالجة،
// فلا يقرأ الطلب غير المصادق عليه جسم الملف إطلاقاً، ولا يستهلك عملية FFmpeg.

import type { NextFunction, Request, RequestHandler, Response } from "express";

export const VOICE_RATE_LIMIT_WINDOW_MS = 60_000;
export const VOICE_RATE_LIMIT_MAX = 8;
export const VOICE_MAX_CONCURRENT_TRANSCODES = 2;

export function readBearerToken(req: Pick<Request, "header">): string {
  const authorization = req.header("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export interface VoiceGateOptions {
  /** يتحقق من التوكن ويعيد معرّف المستخدم أو null. */
  verifyToken(token: string): Promise<string | null>;
  now?: () => number;
  windowMs?: number;
  maxPerWindow?: number;
  maxConcurrent?: number;
}

export interface VoiceGate {
  middleware: RequestHandler;
  /** عدد عمليات FFmpeg الجارية الآن (للتشخيص والاختبار). */
  inFlight(): number;
}

/**
 * بوابة بمصادقة وحدّ معدل لكل مستخدم وحدّ تزامن عام. الحجز يُحرَّر عند إغلاق
 * الاستجابة، فيُحرَّر أيضاً عند فشل قراءة الجسم (413) أو انقطاع العميل.
 */
export function createVoiceGate(options: VoiceGateOptions): VoiceGate {
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? VOICE_RATE_LIMIT_WINDOW_MS;
  const maxPerWindow = options.maxPerWindow ?? VOICE_RATE_LIMIT_MAX;
  const maxConcurrent = options.maxConcurrent ?? VOICE_MAX_CONCURRENT_TRANSCODES;

  const buckets = new Map<string, { count: number; resetAt: number }>();
  let inFlight = 0;

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const token = readBearerToken(req);
      if (!token) {
        res.status(401).json({ success: false, error: "Authentication is required." });
        return;
      }

      const userId = await options.verifyToken(token).catch(() => null);
      if (!userId) {
        res.status(401).json({ success: false, error: "The session is invalid or expired." });
        return;
      }

      const current = now();
      const existing = buckets.get(userId);
      const entry = !existing || existing.resetAt <= current
        ? { count: 0, resetAt: current + windowMs }
        : existing;
      if (entry.count >= maxPerWindow) {
        res.status(429).json({ success: false, error: "Too many voice conversions. Try again shortly." });
        return;
      }
      if (inFlight >= maxConcurrent) {
        res.status(429).json({ success: false, error: "The voice converter is busy. Try again shortly." });
        return;
      }

      entry.count += 1;
      buckets.set(userId, entry);
      inFlight += 1;

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        inFlight = Math.max(0, inFlight - 1);
      };
      // يُحرَّر دائماً: نجاح، خطأ في المعالجة، أو فشل قراءة الجسم
      res.on("close", release);

      res.locals.voiceUserId = userId;
      next();
    })().catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: "Could not authorize the voice request." });
      }
    });
  };

  return { middleware, inFlight: () => inFlight };
}
