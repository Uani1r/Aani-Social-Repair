import { Router, type IRouter } from "express";
import healthRouter from "./health";
import imagekitAuthRouter from "./imagekitAuth";
import mediaCleanupRouter from "./mediaCleanup";
import mediaProcessingRouter from "./mediaProcessing";
import pushNotificationsRouter from "./pushNotifications";

const router: IRouter = Router();

router.use(healthRouter);
router.use(imagekitAuthRouter);
router.use(mediaCleanupRouter);
router.use(mediaProcessingRouter);
router.use(pushNotificationsRouter);

/**
 * ملاحظة مهمة:
 * تفاعلات المنشورات (الإعجاب، التعليقات، إعادة النشر، المشاركة، الحفظ) لم تعد
 * تُدار من هذا الخادم. أصبح العميل يكتبها ويقرأها مباشرة من قاعدة البيانات
 * (Supabase) عبر `src/lib/interactions.ts`، والعدادات تُحدَّث بمُشغّلات (triggers)
 * داخل قاعدة البيانات، لذلك لا يوجد أي تخزين وهمي في الذاكرة بعد الآن.
 *
 * المسارات القديمة `/api/posts/:id/{interactions,comments,like,bookmark,share}`
 * كانت تحفظ الحالة في الذاكرة فقط (وتفقدها عند إعادة تشغيل الخادم)، وقد أُزيلت
 * نهائياً حتى لا يعود أي عميل إلى استخدامها بالخطأ.
 */

export default router;
