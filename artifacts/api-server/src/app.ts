
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import pushNotificationsRouter, { handlePushWebhook } from "./routes/pushNotifications";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.status(200).json({ success: true, status: "ok" });
});

app.use("/api", router);

// مسارات Webhook إضافية على جذر الخادم (إضافة إلى /api/send-push-notification
// و /api/push-webhook و /api/webhook المسجلة داخل الراوتر).
// أي استدعاء من Supabase على هذه المسارات يُعالج فوراً ويعيد 200 — لا 404.
app.post(["/", "/webhook", "/push-webhook", "/notifications/webhook"], (req, res) => {
  void handlePushWebhook(req, res);
});

app.get(["/webhook", "/push-webhook", "/notifications/webhook"], (_req, res) => {
  res.status(200).json({ success: true, message: "Push webhook endpoint is live." });
});

// معالجة JSON غير الصالح
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) return next(err);

    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({
        success: false,
        error: "صيغة البيانات المرسلة غير صحيحة",
      });
    }

    logger.error({ err }, "API error");

    return res.status(500).json({
      success: false,
      error: "حدث خطأ داخلي في الخادم",
    });
  },
);

export default app;
