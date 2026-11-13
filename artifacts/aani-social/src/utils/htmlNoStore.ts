// وسيط no-store لاستجابات HTML — منطق خالص قابل للاختبار (بلا Node/http):
//
// يُثبَّت على استجابة واحدة ويضمن أن كل استجابة HTML فعلية تحمل
// Cache-Control: no-store قبل إرسال الرؤوس، مهما كان ترتيب ضبط الترويسات:
//   - Cache-Control قبل Content-Type
//   - Content-Type قبل Cache-Control
//   - Content-Type تمرَّر مباشرة داخل كائن/مصفوفة ترويسات writeHead
// ولا يغيّر قيمة Content-Type مطلقاً، ولا يمس JS/CSS/الصور/الخطوط.

export interface HttpResponseLike {
  headersSent: boolean;
  getHeader(name: string): unknown;
  setHeader(name: string, value: unknown): unknown;
  writeHead(...args: unknown[]): unknown;
  end(...args: unknown[]): unknown;
}

export function applyHtmlNoStoreInterceptors(res: HttpResponseLike): void {
  const isHtmlValue = (value: unknown): boolean =>
    typeof value === 'string' && value.includes('text/html');
  const resIsHtml = (): boolean => isHtmlValue(res.getHeader('Content-Type'));

  const originalSetHeader = res.setHeader.bind(res);
  const originalWriteHead = res.writeHead.bind(res);
  const originalEnd = res.end.bind(res);

  // فرض no-store على استجابة HTML قبل الإرسال — دون المساس بأي ترويسة أخرى
  const enforceOnResponse = (): void => {
    if (res.headersSent || !resIsHtml()) return;
    if (res.getHeader('Cache-Control') !== 'no-store') {
      originalSetHeader('Cache-Control', 'no-store');
    }
  };

  res.setHeader = ((name: string, value: unknown) => {
    const lowered = name.toLowerCase();
    // Cache-Control على استجابة HTML مكتملة النوع → إجبار no-store
    if (lowered === 'cache-control' && resIsHtml()) {
      return originalSetHeader(name, 'no-store');
    }
    const result = originalSetHeader(name, value);
    // Content-Type = html بعد وجود Cache-Control: يُضبط no-store كترويسة
    // منفصلة — قيمة Content-Type نفسها تبقى كما هي دون أي تغيير.
    if (lowered === 'content-type' && isHtmlValue(value)) {
      enforceOnResponse();
    }
    return result;
  }) as HttpResponseLike['setHeader'];

  // استخراج ترويسات writeHead من كل الصيغ المدعومة:
  // writeHead(status, headers) و writeHead(status, message, headers)
  const headersFromArgs = (args: unknown[]): unknown => {
    for (let i = args.length - 1; i >= 1; i -= 1) {
      const arg = args[i];
      if (Array.isArray(arg)) return arg;
      if (typeof arg === 'object' && arg !== null) return arg;
    }
    return null;
  };

  res.writeHead = ((...args: unknown[]) => {
    const headers = headersFromArgs(args);
    let passedIsHtml = resIsHtml();
    if (Array.isArray(headers)) {
      // صيغة المصفوفة المتزامنة: [[name, value], ...]
      let htmlInArgs = false;
      let cacheIndex = -1;
      headers.forEach((tuple, index) => {
        if (!Array.isArray(tuple) || tuple.length < 2) return;
        const key = String(tuple[0]).toLowerCase();
        if (key === 'content-type' && isHtmlValue(tuple[1])) htmlInArgs = true;
        if (key === 'cache-control') cacheIndex = index;
      });
      passedIsHtml = passedIsHtml || htmlInArgs;
      if (passedIsHtml && cacheIndex >= 0) {
        (headers[cacheIndex] as unknown[])[1] = 'no-store';
      }
    } else if (typeof headers === 'object' && headers !== null) {
      // صيغة الكائن: { 'Content-Type': ..., 'Cache-Control': ... }
      const obj = headers as Record<string, unknown>;
      let htmlInArgs = false;
      let cacheKey: string | null = null;
      for (const key of Object.keys(obj)) {
        const lowered = key.toLowerCase();
        if (lowered === 'content-type' && isHtmlValue(obj[key])) htmlInArgs = true;
        if (lowered === 'cache-control') cacheKey = key;
      }
      passedIsHtml = passedIsHtml || htmlInArgs;
      if (passedIsHtml && cacheKey !== null) {
        obj[cacheKey] = 'no-store';
      }
    }
    if (passedIsHtml && !res.headersSent) {
      originalSetHeader('Cache-Control', 'no-store');
    }
    return originalWriteHead(...args);
  }) as HttpResponseLike['writeHead'];

  res.end = ((...args: unknown[]) => {
    enforceOnResponse();
    return originalEnd(...args);
  }) as HttpResponseLike['end'];
}
