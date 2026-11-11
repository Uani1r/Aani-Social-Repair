/**
 * إدارة رجوع النوافذ والشاشات الفرعية عبر تاريخ المتصفح (popstate):
 *
 * - كل نافذة/عارض مفتوح يسجّل معالج إغلاق في رصة LIFO مركزية ويدفع
 *   مدخلاً في تاريخ المتصفح عند الفتح.
 * - زر الرجوع في الهاتف/المتصفح يغلق النافذة العلوية فقط ويعيد المستخدم
 *   إلى الشاشة التي كان عليها تماماً (بدون مغادرة الصفحة أو التوجيه للرئيسية).
 * - الإغلاق البرمجي (زر X / Escape) يستعيد مدخل التاريخ تلقائياً حتى لا
 *   يتراكم السجل ويتطلب المستخدم ضغطات رجوع زائدة.
 * - عند الإغلاق عبر الرجوع يُفَكّ قفل تمرير الصفحة إن لم تبقَ حوارات أخرى.
 */

export type OverlayCloseHandler = () => void;

type OverlayEntry = {
  close: OverlayCloseHandler;
  closedByBack: boolean;
};

const overlayStack: OverlayEntry[] = [];
let nextOverlayId = 1;
let selfBackDepth = 0;
let listenerInstalled = false;

function releaseBodyScrollSafely() {
  if (typeof document === 'undefined') return;
  window.requestAnimationFrame(() => {
    const remainingOpenDialog = Boolean(document.querySelector(
      '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
    ));
    // لا تفك القفل إن بقي مالك آخر (مثل محرر قص الفيديو داخل تدفق النشر)
    if (remainingOpenDialog) return;
    document.body.style.overflow = 'unset';
    document.body.style.position = 'static';
    document.body.style.overscrollBehavior = '';
    document.body.classList.remove('overflow-hidden', 'fixed', 'inset-0');
  });
}

function handlePopstate(event: PopStateEvent) {
  // popstate ناتج عن history.back() برمجي أثناء إغلاق نافذة → تجاهله
  if (selfBackDepth > 0) {
    selfBackDepth -= 1;
    return;
  }

  const top = overlayStack[overlayStack.length - 1];
  // لا نوافذ مفتوحة → رجوع حقيقي بين الصفحات؛ لكن إن عدنا إلى مدخل حرس
  // يحمل سياق شاشة قابلة للاستعادة (مثل قائمة المتابعين) أعِد فتحها بنفس الحالة
  if (!top) {
    const restoreData = (event.state as { aaniOverlayRestore?: unknown } | null)?.aaniOverlayRestore;
    if (restoreData) {
      window.dispatchEvent(new CustomEvent('aani:restore-overlay', { detail: restoreData }));
    }
    return;
  }

  top.closedByBack = true;
  overlayStack.pop();
  try {
    top.close();
  } catch {
    /* معالج الإغلاق قد يرمي إن فُكّ المكون بالفعل */
  }
  releaseBodyScrollSafely();
}

function ensureOverlayBackListener() {
  if (listenerInstalled || typeof window === 'undefined') return;
  listenerInstalled = true;
  window.addEventListener('popstate', handlePopstate);
}

export type OverlayBackOptions = {
  /** سياق الشاشة المحفوظ في مدخل السجل لاستعادته عند الرجوع إليه */
  restoreData?: unknown;
  /** استبدل المدخل الحالي بدل دفع مدخل جديد (تُستخدم عند إعادة الفتح من سياق محفوظ) */
  replaceHistory?: boolean;
};

/**
 * سجّل نافذة مفتوحة في رصة الرجوع المركزية وادفع مدخلاً في التاريخ.
 * يعيد دالة إلغاء التسجيل تُستدعى في cleanup الخاص بـ useEffect.
 */
export function registerOverlayBack(onClose: OverlayCloseHandler, options?: OverlayBackOptions): () => void {
  if (typeof window === 'undefined') return () => {};
  ensureOverlayBackListener();

  const entry: OverlayEntry = { close: onClose, closedByBack: false };
  overlayStack.push(entry);
  const historyState = { aaniOverlayId: nextOverlayId, aaniOverlayRestore: options?.restoreData ?? null };
  if (options?.replaceHistory) {
    window.history.replaceState(historyState, '');
  } else {
    window.history.pushState(historyState, '');
  }
  nextOverlayId += 1;

  return () => {
    const index = overlayStack.indexOf(entry);
    if (index !== -1) overlayStack.splice(index, 1);
    // إذا أُغلقت عبر زر الرجوع فقد استُهل مدخل التاريخ في popstate بالفعل؛
    // أما الإغلاق البرمجي فيستهلك مدخله تلقائياً.
    if (!entry.closedByBack) {
      selfBackDepth += 1;
      window.history.back();
    }
  };
}

/**
 * حرّر أعلى نافذة من رصة الرجوع قبل تنقل مقصود (إغلاق ثم فتح شاشة أخرى):
 * مدخل الحرس يبقى في التاريخ ليُستعاد عبر الرجوع، ولن يستهلكه إلغاء التسجيل.
 */
export function releaseOverlayBackForNavigation(): void {
  const top = overlayStack[overlayStack.length - 1];
  if (!top) return;
  top.closedByBack = true;
  overlayStack.pop();
}

/**
 * رجوع آمن بلا شاشة بيضاء: تحقق من وجود سجل سابق أولاً،
 * وإن لم يوجد انتقل إلى مسار احتياطي عبر حدث التنقل الذي يعالجه Shell.
 */
export function goBackOrPush(fallbackPath: string = '/profile'): void {
  if (typeof window === 'undefined') return;
  try {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
  } catch {
    /* تجاهل فشل الوصول للتاريخ */
  }
  window.dispatchEvent(new CustomEvent('aani:navigate', { detail: fallbackPath }));
}
