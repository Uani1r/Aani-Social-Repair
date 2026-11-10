/**
 * ذاكرة موضع التمرير لكل مسار (Route):
 * يحفظ موضع تمرير الصفحة عند مغادرة المسار ويعيده عند العودة إليه،
 * بينما تبقى البيانات مخزنة في الكاش (مثل postsCache في usePosts)
 * فلا يعود المستخدم إلى أعلى الصفحة أو يرى فراغاً أثناء التحديث.
 */

const scrollPositions = new Map<string, number>();
const visitedRoutes = new Set<string>();

export function saveRouteScrollPosition(key: string, value: number) {
  scrollPositions.set(key, value);
}

export function readRouteScrollPosition(key: string): number {
  return scrollPositions.get(key) || 0;
}

export function hasVisitedRoute(key: string): boolean {
  return visitedRoutes.has(key);
}

export function markRouteVisited(key: string) {
  visitedRoutes.add(key);
}

/** إعادة الضبط عند تسجيل الخروج أو تغيّر الحساب حتى لا تُستعاد مواضع قديمة */
export function clearRouteScrollMemory() {
  scrollPositions.clear();
  visitedRoutes.clear();
}
