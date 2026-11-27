/**
 * تصنيف طلبات الخادم الذي يخدم واجهة SPA على Render.
 *
 * خدمة Render الفعلية (render.yaml) هي `type: web` بـ`runtime: docker`: حاوية
 * Express تخدم الواجهة المبنية و`/api` معاً. لذلك لا يكفي rewrite في لوحة
 * Render، بل يلزم أن يتعامل الخادم نفسه مع مسارات SPA:
 *   * `/api/*` لا يُلمس (JSON فقط، ولا يُعاد إليه index.html أبداً).
 *   * طلب ملف (له امتداد) غير موجود → 404 صريح، لا HTML مكان JS/CSS.
 *   * أي مسار آخر (بلا امتداد) → index.html، فتعمل المسارات المباشرة
 *     وتحديث الصفحة و`/auth/callback`.
 *   * غير GET/HEAD → 405، لا index.html ولا 404 مبهم.
 */

export type StaticRoute = 'api' | 'static' | 'spa' | 'method_not_allowed';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function classifyStaticRequest(pathname: string, method: string): StaticRoute {
  const path = typeof pathname === 'string' && pathname.startsWith('/') ? pathname : '/';
  // `/api` أولاً: مسار API غير موجود يعيد JSON 404 بأي طريقة، ولا يصله HTML
  // ولا 405 مضلّل (المسارات المسجّلة تُعالَج قبله في app.ts).
  if (path === '/api' || path.startsWith('/api/')) return 'api';

  if (!SAFE_METHODS.has(String(method || '').toUpperCase())) return 'method_not_allowed';

  // اسم الملف الأخير: امتداد يعني طلب أصل ثابت (JS/CSS/صورة/خط/خريطة).
  const lastSegment = path.split('/').pop() || '';
  if (lastSegment.includes('.')) return 'static';

  return 'spa';
}
