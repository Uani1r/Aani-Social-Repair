/**
 * مدير الفيديو النشط الموحد (Global Active Video Manager):
 *
 * يسجّل الفيديو المشغَّل حالياً في التطبيق كله. عند بدء فيديو جديد
 * يُوقف الفيديو السابق فوراً (pause) حتى لا يتسرب أي صوت في الخلفية،
 * وعند مغادرة التطبيق (visibilitychange → hidden) يُوقف النشط ويُستأنف
 * عند العودة إن كان يعمل قبل الإخفاء.
 *
 * يُستخدم من مشغّل الفيديو في الواجهة الرئيسية (PostVideoPreview)
 * ومشغّل الريلز (ReelSlide) قبل أي video.play().
 */

type ActiveVideoEntry = { id: string; element: HTMLVideoElement };

let active: ActiveVideoEntry | null = null;
let resumeAfterVisible = false;
let bound = false;

function bindGlobalHandlers() {
  if (bound || typeof document === 'undefined') return;
  bound = true;
  document.addEventListener('visibilitychange', () => {
    const video = active?.element;
    if (!video) return;
    if (document.visibilityState === 'hidden') {
      resumeAfterVisible = !video.paused;
      try {
        video.pause();
      } catch {
        /* تجاهل */
      }
    } else if (resumeAfterVisible && video.isConnected) {
      resumeAfterVisible = false;
      try {
        void video.play().catch(() => undefined);
      } catch {
        /* تجاهل */
      }
    } else {
      resumeAfterVisible = false;
    }
  });
}

/** ادّعِ حصرية التشغيل: أوقف أي فيديو نشط آخر فوراً وسجّل هذا الفيديو */
export function claimActiveVideo(id: string, element: HTMLVideoElement): void {
  bindGlobalHandlers();
  if (active && active.id !== id && active.element !== element && active.element.isConnected && !active.element.paused) {
    try {
      active.element.pause();
    } catch {
      /* تجاهل */
    }
  }
  active = { id, element };
}

/** أفرغ التسجيل إن كان هذا الفيديو هو النشط (عند الخروج من الشاشة أو الإزالة) */
export function releaseActiveVideo(id: string): void {
  if (active?.id === id) active = null;
}

/** شغّل الفيديو مع ادّعاء الحصرية (يوقف كل فيديو آخر يعمل في التطبيق) */
export function playExclusive(id: string | undefined, element: HTMLVideoElement): void {
  if (id) claimActiveVideo(id, element);
  void element.play().catch(() => undefined);
}
