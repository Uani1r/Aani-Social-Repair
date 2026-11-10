// تسريع الميديا في كامل التطبيق:
// - تحميل مسبق (Preload) للصور وتهيئة (Prebuffer) للفيديوهات في
//   الخلفية قبل أن يقرر المستخدم النقر عليها.
// - عناوين مصغّرات للصور (Thumbnails) عند توفر تحويلات Supabase
//   Storage، مع بقاء الرابط الأصلي احتياطاً عند فشل التحويل.
// - منع الطلبات المكررة: كل رابط يُحمَّل مرة واحدة فقط، والمتصفح
//   يحتفظ به في HTTP cache فلا يُعاد تنزيله عند الفتح للمرة الثانية.

const preloadedMedia = new Set<string>();
const inFlightImages = new Set<string>();

function isSupabaseStoragePublicUrl(url: string): boolean {
  return url.includes('/storage/v1/object/public/');
}

/**
 * عنوان مصغّرة للصور: يستفيد من تحويلات Supabase Storage
 * (width/quality) لتقليل حجم النقل في الشبكات والقوائم.
 * الرابط الأصلي يبقى المستخدم احتياطياً عند فشل التحويل.
 */
export function thumbnailUrl(url: string | null | undefined, width = 480): string {
  const source = typeof url === 'string' ? url : '';
  if (!source || !isSupabaseStoragePublicUrl(source)) return source;
  const separator = source.includes('?') ? '&' : '?';
  return `${source}${separator}width=${width}&quality=80`;
}

/** تحميل صورة مسبقاً (Preload) مع منع الطلبات المكررة */
export function preloadImage(url: string | null | undefined): void {
  const source = typeof url === 'string' ? url : '';
  if (!source || preloadedMedia.has(source) || inFlightImages.has(source)) return;

  inFlightImages.add(source);
  const image = new Image();
  image.onload = () => {
    inFlightImages.delete(source);
    preloadedMedia.add(source);
  };
  image.onerror = () => {
    inFlightImages.delete(source);
  };
  image.src = source;
}

/**
 * تهيئة فيديو مسبقاً (Prebuffer): عنصر وهمي يجلب البيانات الوصفية
 * والثواني الأولى ثم يُفرَّغ — المتصفح يحتفظ بما حمّله في ذاكرة
 * HTTP فيبدأ الفتح الحقيقي من الذاكرة بدل الشبكة.
 */
export function prebufferVideo(url: string | null | undefined): void {
  const source = typeof url === 'string' ? url : '';
  if (!source || preloadedMedia.has(source) || typeof document === 'undefined') return;

  preloadedMedia.add(source);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.setAttribute('playsInline', 'true');

  let released = false;
  const cleanup = () => {
    if (released) return;
    released = true;
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* العنصر قد يكون أفلت مرجعه بالفعل */
    }
  };

  video.onloadedmetadata = cleanup;
  video.onerror = cleanup;
  // مهلة أمان: تفريغ العنصر إن تعطلت الأحداث
  window.setTimeout(cleanup, 12000);
  video.src = source;
}

/** تهيئة الرابط المناسب حسب النوع: فيديو → Prebuffer، صورة → Preload */
export function preloadMedia(url: string | null | undefined): void {
  const source = typeof url === 'string' ? url : '';
  if (!source) return;
  const isVideo = /\.(mp4|webm|mov|m4v|avi|mkv)(\?|#|$)/i.test(source);
  if (isVideo) prebufferVideo(source);
  else preloadImage(source);
}

/**
 * تهيئة دفعة روابط بلا ازدحام: عنصران تقريباً متزامنان مع تأخير
 * متدرج حتى لا تنافس التحميلات المسبقة الشبكة أثناء التصفح.
 */
export function preloadMediaList(urls: Array<string | null | undefined>, limit = 6): void {
  urls
    .filter((url): url is string => typeof url === 'string' && Boolean(url))
    .slice(0, limit)
    .forEach((url, index) => {
      window.setTimeout(() => preloadMedia(url), index * 120);
    });
}

/** أول رابط وسائط لمنشور (أول صورة أو الفيديو نفسه) */
export function firstMediaUrlOfPost(post: { media_url?: string | null; media_urls?: string[] | null } | null | undefined): string | null {
  if (!post) return null;
  if (Array.isArray(post.media_urls) && post.media_urls.length > 0) return post.media_urls[0];
  return post.media_url || null;
}
