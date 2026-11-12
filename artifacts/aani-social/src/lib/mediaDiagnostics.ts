// نظام تشخيص الوسائط — وحدة مستقلة تماماً (Standalone / Non-Intrusive).
//
// المبدأ: لا يعدّل هذا الملف أي سطر في كود الضغط أو المنشورات أو الريلز أو
// منظومة التنظيف الآلي. يعمل كطبقة رصد على شبكة المتصفح فقط:
// - يغلف window.fetch و XMLHttpRequest بشفافية كاملة (نفس النداء، نفس النتيجة)
//   ويرصد فقط النداءات المتعلقة بالوسائط:
//     • https://upload.imagekit.io/...  → مرحلة [الرفع إلى ImageKit]
//     • /api/media/imagekit-auth        → مرحلة [جلب توقيع ImageKit]
//     • /rest/v1/rpc/aani_create_story  → مرحلة [الحفظ في قاعدة البيانات]
//     • media_upload_ledger             → مرحلة [سجل الرفع]
// - عند أي فشل (HTTP ≥ 400 أو خطأ شبكة) يسجّل حدثاً تشخيصياً يعرض:
//     المرحلة، نقطة النهاية، كود الحالة، الرسالة الخام كاملة،
//     وحضور publicKey/token/expire/signature وصيغة expire ونوع/حجم الملف.
// - لا يطبع ولا ينسخ أي مفتاح سري: IMAGEKIT_PRIVATE_KEY لا يغادر الخادم
//   أصلاً، وقيمة signature لا تُعرض (حضورها وطولها فقط) حتى لا تُنشر علناً
//   في لقطة شاشة أو رسالة.
// - فشل تنفيذ أي شيء في هذه الوحدة لا يجب أن يؤثر على التطبيق إطلاقاً:
//   كل شيء داخل try/catch، والرصد صامت تماماً عند عدم الحاجة.

export type MediaDiagnosticStage =
  | 'الرفع إلى ImageKit'
  | 'جلب توقيع ImageKit'
  | 'الحفظ في قاعدة البيانات (نشر القصة)'
  | 'سجل الرفع (media_upload_ledger)'
  | 'عملية شبكة أخرى';

export interface MediaDiagnosticParams {
  publicKeyPresent?: boolean;
  publicKeyPrefix?: string;
  tokenPresent?: boolean;
  tokenPrefix?: string;
  expirePresent?: boolean;
  /** قيمة expire كما هي — ليست سراً (طابع زمني) وتُعرض لفحص الصيغة */
  expireValue?: string;
  expireFormat?: string;
  signaturePresent?: boolean;
  signatureLength?: number;
  fileType?: string;
  fileSizeBytes?: number;
  fileName?: string;
}

export interface MediaDiagnosticEvent {
  id: string;
  at: number;
  stage: MediaDiagnosticStage;
  endpoint: string;
  method: string;
  httpStatus: number | null;
  ok: boolean;
  networkError?: string;
  /** الرسالة الخام من الخادم/ImageKit/Supabase — مقصوصة عند الطول الكبير */
  rawResponse: string;
  params?: MediaDiagnosticParams;
}

const MAX_EVENTS = 20;
const RAW_RESPONSE_MAX_CHARS = 1500;
const AUTH_LINK_WINDOW_MS = 10 * 60 * 1000;

const events: MediaDiagnosticEvent[] = [];
const listeners = new Set<(event: MediaDiagnosticEvent) => void>();

function classifyStage(url: string): MediaDiagnosticStage {
  const u = url.toLowerCase();
  if (u.includes('upload.imagekit.io')) return 'الرفع إلى ImageKit';
  if (u.includes('imagekit-auth')) return 'جلب توقيع ImageKit';
  if (u.includes('/rest/v1/rpc/aani_create_story')) return 'الحفظ في قاعدة البيانات (نشر القصة)';
  if (u.includes('media_upload_ledger')) return 'سجل الرفع (media_upload_ledger)';
  return 'عملية شبكة أخرى';
}

function isTrackedUrl(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes('upload.imagekit.io')
    || u.includes('imagekit-auth')
    || u.includes('/rest/v1/rpc/aani_create_story')
    || u.includes('media_upload_ledger');
}

export function describeExpireFormat(value: string): string {
  if (!/^\d+$/.test(value)) {
    return `غير رقمي ("${value.slice(0, 24)}") — ImageKit يتوقع ثوانٍ unix`;
  }
  if (value.length === 10) return '10 خانات (ثوانٍ unix) — صحيح';
  if (value.length === 13) return '13 خانة (مللي ثانية!) — ImageKit يتوقع ثوانٍ (10 خانات)';
  return `${value.length} خانة — ImageKit يتوقع ثوانٍ unix (10 خانات)`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function paramsFromForm(form: FormData): MediaDiagnosticParams {
  const params: MediaDiagnosticParams = {};
  try {
    const publicKey = form.get('publicKey');
    const token = form.get('token');
    const expire = form.get('expire');
    const signature = form.get('signature');

    params.publicKeyPresent = publicKey != null && String(publicKey).length > 0;
    params.publicKeyPrefix = optionalString(publicKey)?.slice(0, 12);
    params.tokenPresent = token != null && String(token).length > 0;
    params.tokenPrefix = optionalString(token)?.slice(0, 8);
    if (expire != null) {
      const value = String(expire);
      params.expirePresent = value.length > 0;
      params.expireValue = value;
      params.expireFormat = describeExpireFormat(value);
    }
    params.signaturePresent = signature != null && String(signature).length > 0;
    params.signatureLength = signature != null ? String(signature).length : 0;

    const file = form.get('file');
    if (file && typeof file === 'object') {
      const blob = file as Blob;
      if (typeof blob.size === 'number') {
        params.fileType = blob.type || undefined;
        params.fileSizeBytes = blob.size;
        params.fileName = (file as File).name || undefined;
      }
    }
  } catch {
    // الرصد لا يفشل الرفع أبداً
  }
  return params;
}

function paramsFromAuthBody(text: string): MediaDiagnosticParams | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const params: MediaDiagnosticParams = {
      publicKeyPresent: typeof parsed.publicKey === 'string' && parsed.publicKey.length > 0,
      tokenPresent: typeof parsed.token === 'string' && parsed.token.length > 0,
      expirePresent: parsed.expire != null,
      signaturePresent: typeof parsed.signature === 'string' && parsed.signature.length > 0,
    };
    if (typeof parsed.publicKey === 'string') params.publicKeyPrefix = parsed.publicKey.slice(0, 12);
    if (typeof parsed.token === 'string') params.tokenPrefix = parsed.token.slice(0, 8);
    if (parsed.expire != null) {
      const value = String(parsed.expire);
      params.expireValue = value;
      params.expireFormat = describeExpireFormat(value);
    }
    if (typeof parsed.signature === 'string') params.signatureLength = parsed.signature.length;
    return params;
  } catch {
    return undefined;
  }
}

function truncateRaw(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > RAW_RESPONSE_MAX_CHARS
    ? `${trimmed.slice(0, RAW_RESPONSE_MAX_CHARS)}… (مقصوص)`
    : trimmed;
}

function pushEvent(event: MediaDiagnosticEvent): void {
  try {
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    // التنبيه المرئي للفشل فقط — نجاح جلب التوقيع يُخزَّن كمرجع للتقرير
    if (!shouldAlert(event)) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // مستمع معطوب لا يوقف الآخرين
      }
    }
  } catch {
    // صامت دائماً
  }
}

function shouldAlert(event: MediaDiagnosticEvent): boolean {
  return event.httpStatus === null || event.httpStatus >= 400;
}

let eventCounter = 0;

function recordResult(options: {
  url: string;
  method: string;
  httpStatus: number | null;
  networkError?: string;
  rawResponse?: string;
  params?: MediaDiagnosticParams;
}): void {
  try {
    const stage = classifyStage(options.url);
    const event: MediaDiagnosticEvent = {
      id: `diag-${Date.now()}-${eventCounter += 1}`,
      at: Date.now(),
      stage,
      endpoint: options.url,
      method: options.method,
      httpStatus: options.httpStatus,
      ok: options.httpStatus !== null && options.httpStatus >= 200 && options.httpStatus < 300,
      networkError: options.networkError,
      rawResponse: truncateRaw(options.rawResponse || ''),
      params: options.params,
    };
    // نجاح جلب التوقيع يُسجَّل دائماً (يُستعمل كمرجع عند فشل الرفع بعده)
    if (stage === 'جلب توقيع ImageKit' || shouldAlert(event)) {
      pushEvent(event);
    }
  } catch {
    // صامت دائماً
  }
}

function readXhrRawResponse(xhr: XMLHttpRequest): string {
  try {
    if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText || '';
    return '';
  } catch {
    return '';
  }
}

let installed = false;

/** تُفعَّل مرة واحدة من App — فشل التفعيل لا يؤثر على التطبيق */
export function initMediaDiagnostics(): void {
  if (installed) return;
  installed = true;

  // ===== تغليف fetch =====
  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url = '';
    try {
      url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    } catch {
      url = '';
    }
    const method = (init?.method || (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET') || 'GET').toUpperCase();

    if (!url || !isTrackedUrl(url)) {
      return originalFetch(input, init);
    }

    let params: MediaDiagnosticParams | undefined;
    try {
      if (init?.body instanceof FormData) {
        params = paramsFromForm(init.body);
      }
    } catch {
      // صامت
    }

    try {
      const response = await originalFetch(input, init);
      const capture = stageAlwaysCaptures(url) || !response.ok;
      if (capture) {
        const cloned = response.clone();
        void cloned.text().then(text => {
          const merged = stageAlwaysCaptures(url) && url.toLowerCase().includes('imagekit-auth')
            ? { ...params, ...paramsFromAuthBody(text) }
            : params;
          recordResult({
            url,
            method,
            httpStatus: response.status,
            rawResponse: text,
            params: merged,
          });
        }).catch(() => {
          recordResult({ url, method, httpStatus: response.status, rawResponse: '', params });
        });
      }
      return response;
    } catch (networkError) {
      recordResult({
        url,
        method,
        httpStatus: null,
        networkError: networkError instanceof Error ? networkError.message : String(networkError),
        rawResponse: '',
        params,
      });
      throw networkError;
    }
  }) as typeof window.fetch;

  // ===== تغليف XMLHttpRequest =====
  const xhrProto = window.XMLHttpRequest.prototype as unknown as Record<string, unknown> & {
    open: (...args: unknown[]) => unknown;
    send: (body?: Document | XMLHttpRequestBodyInit | null) => unknown;
  };
  const originalOpen = xhrProto.open;
  const originalSend = xhrProto.send;

  xhrProto.open = function open(this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const owner = this as unknown as { __diagUrl?: string; __diagMethod?: string };
      owner.__diagUrl = String(args[1] ?? '');
      owner.__diagMethod = String(args[0] ?? 'GET').toUpperCase();
    } catch {
      // صامت
    }
    return originalOpen.apply(this, args);
  };

  xhrProto.send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const owner = this as unknown as { __diagUrl?: string; __diagMethod?: string; __diagBody?: unknown };
      const url = owner.__diagUrl || '';
      if (url && isTrackedUrl(url)) {
        owner.__diagBody = body;
        this.addEventListener('loadend', () => {
          const status = this.status; // 0 عند فشل الشبكة
          let raw = '';
          try {
            raw = readXhrRawResponse(this);
          } catch {
            raw = '';
          }
          let params: MediaDiagnosticParams | undefined;
          if (owner.__diagBody instanceof FormData) {
            params = paramsFromForm(owner.__diagBody);
          }
          recordResult({
            url,
            method: owner.__diagMethod || 'GET',
            httpStatus: status > 0 ? status : null,
            networkError: status === 0 ? 'فشل شبكي (لا استجابة من الخادم)' : undefined,
            rawResponse: raw,
            params,
          });
        });
      }
    } catch {
      // صامت
    }
    return originalSend.call(this, body);
  };
}

function stageAlwaysCaptures(url: string): boolean {
  return classifyStage(url) === 'جلب توقيع ImageKit';
}

export function subscribeMediaDiagnostics(listener: (event: MediaDiagnosticEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMediaDiagnosticEvents(): readonly MediaDiagnosticEvent[] {
  return events;
}

/** إزاحة المرحلة التي فشلت — للأماكن التي يرصدها المتصفح لا الشبكة (احتياطي مستقبلي) */
export function reportMediaStageFailure(
  stage: MediaDiagnosticStage,
  details: { endpoint?: string; rawResponse?: string; httpStatus?: number },
): void {
  recordResult({
    url: details.endpoint || '(داخلي)',
    method: '—',
    httpStatus: details.httpStatus ?? null,
    rawResponse: details.rawResponse || '',
  });
}

function describeBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'غير معروف';
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} كيلوبايت`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} ميغابايت`;
}

function findLatestAuthEvent(beforeAt: number): MediaDiagnosticEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const candidate = events[i];
    if (candidate.stage === 'جلب توقيع ImageKit' && candidate.at <= beforeAt
      && beforeAt - candidate.at <= AUTH_LINK_WINDOW_MS) {
      return candidate;
    }
  }
  return undefined;
}

function describeParams(params?: MediaDiagnosticParams): string[] {
  if (!params) return [];
  const lines: string[] = [];
  lines.push(`publicKey: ${params.publicKeyPresent ? `موجود (${params.publicKeyPrefix || ''}…)` : 'فارغ/مفقود!'}`);
  lines.push(`token: ${params.tokenPresent ? `موجود (${params.tokenPrefix || ''}…)` : 'فارغ/مفقود!'}`);
  lines.push(`expire: ${params.expirePresent ? `موجود = ${params.expireValue} → ${params.expireFormat}` : 'فارغ/مفقود!'}`);
  lines.push(`signature: ${params.signaturePresent ? `موجود (طوله ${params.signatureLength})` : 'فارغ/مفقود!'}`);
  if (params.fileType || params.fileSizeBytes != null) {
    lines.push(`الملف: ${params.fileType || 'نوع غير معروف'} — ${describeBytes(params.fileSizeBytes)}${params.fileName ? ` — الاسم: ${params.fileName}` : ''}`);
  }
  return lines;
}

/** نص التقرير الكامل الجاهز للنسخ — بلا أي أسرار */
export function buildMediaDiagnosticReport(event: MediaDiagnosticEvent): string {
  const lines: string[] = [];
  lines.push('تشخيص وسائط آني — تقرير خطأ');
  lines.push(`الوقت: ${new Date(event.at).toLocaleString('ar')}`);
  lines.push(`المرحلة: [${event.stage}]`);
  lines.push(`الرابط: ${event.endpoint}`);
  lines.push(`الطريقة: ${event.method}`);
  lines.push(`كود الحالة: ${event.httpStatus === null ? 'فشل شبكي (لا استجابة)' : `HTTP ${event.httpStatus}`}`);
  if (event.networkError) lines.push(`خطأ الشبكة: ${event.networkError}`);
  if (event.rawResponse) lines.push(`الرسالة الخام:\n${event.rawResponse}`);
  const eventParams = describeParams(event.params);
  if (eventParams.length > 0) {
    lines.push('معاملات هذا الطلب:');
    lines.push(...eventParams.map(line => `  ${line}`));
  }
  const authEvent = findLatestAuthEvent(event.at);
  if (authEvent && authEvent.id !== event.id) {
    lines.push(`آخر جلب توقيع (${Math.round((event.at - authEvent.at) / 1000)} ثانية قبل الفشل):`);
    lines.push(`  كود الحالة: ${authEvent.httpStatus === null ? 'فشل شبكي' : `HTTP ${authEvent.httpStatus}`}`);
    lines.push(...describeParams(authEvent.params).map(line => `  ${line}`));
  }
  try {
    lines.push(`المتصفح: ${navigator.userAgent.slice(0, 160)}`);
  } catch {
    // غير متاح
  }
  return lines.join('\n');
}

/** نسخ يعمل على iPhone Safari (clipboard + احتياطي execCommand) */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // نجرّب الاحتياطي
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
