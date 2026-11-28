import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * تثبيت آني على iPhone: Web App Manifest مربوط من index.html، وبيانات Apple
 * Web App، وأيقونات حقيقية (PNG بتوقيع وأبعاد فعلية، وSVG للشعار) موجودة
 * في public/ بمساراتها — لا مسار مخترع ولا حجم مزعوم.
 *
 * أبعاد PNG تُقرأ من ترويسة الملف نفسها (IHDR) لا من الاسم ولا من الـmanifest.
 *
 * ما لا يثبته: أن iOS عرض الأيقونة أو منح الإشعار — يحتاج جهازاً حقيقياً.
 */

const LIB_DIR = fileURLToPath(new URL('.', import.meta.url));
const APP_DIR = join(LIB_DIR, '..', '..');
const PUBLIC_DIR = join(APP_DIR, 'public');

const read = (...segments: string[]): string => readFileSync(join(...segments), 'utf8');

const indexHtml = read(APP_DIR, 'index.html');
const manifestText = read(PUBLIC_DIR, 'manifest.webmanifest');
const manifest = JSON.parse(manifestText) as {
  name?: string;
  short_name?: string;
  description?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  orientation?: string;
  background_color?: string;
  theme_color?: string;
  lang?: string;
  dir?: string;
  icons?: Array<{ src?: string; type?: string; sizes?: string; purpose?: string }>;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** يقرأ توقيع PNG وأبعاد IHDR الفعلية من أول 24 بايت. */
function readPngSize(relativePath: string): { width: number; height: number } {
  const bytes = readFileSync(join(PUBLIC_DIR, relativePath));
  assert(bytes.length > 24, `${relativePath}: too short to be a PNG`);
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    assert.equal(bytes[index], PNG_SIGNATURE[index], `${relativePath}: png signature byte ${index}`);
  }
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR', `${relativePath}: the first chunk is IHDR`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
const publicFile = (href: string): string => href.replace(/^\/+/, '');

test('index.html يربط manifest التطبيق', () => {
  assert.equal(indexHtml.includes('rel="manifest"'), true, 'the manifest link must exist');
  assert.equal(indexHtml.includes('href="/manifest.webmanifest"'), true, 'the manifest path must match the file');
  assert.equal(existsSync(join(PUBLIC_DIR, 'manifest.webmanifest')), true, 'the manifest file must exist');
});

test('البيانات الأساسية: الاسم والاختصار والألوان والاتجاه', () => {
  assert.equal(manifest.name, 'آني - Aani | مساحة قريبة');
  assert.equal(manifest.short_name, 'آني');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'portrait');
  assert.equal(manifest.theme_color, '#0b0b0c');
  assert.equal(manifest.background_color, '#0b0b0c');
  assert.equal(manifest.lang, 'ar');
  assert.equal(manifest.dir, 'rtl');
  assert.equal(typeof manifest.description === 'string' && manifest.description.length > 0, true);
});

test('ملفات PNG حقيقية: توقيع صحيح وأبعاد مضبوطة', () => {
  const expected: Array<[string, number]> = [
    ['icons/apple-touch-icon-180.png', 180],
    ['icons/icon-192.png', 192],
    ['icons/icon-512.png', 512],
    ['icons/icon-512-maskable.png', 512],
  ];

  for (const [relativePath, size] of expected) {
    assert.equal(existsSync(join(PUBLIC_DIR, relativePath)), true, `${relativePath} must exist`);
    const { width, height } = readPngSize(relativePath);
    assert.equal(width, size, `${relativePath}: real width`);
    assert.equal(height, size, `${relativePath}: real height`);
  }
});

test('manifest يعلن أيقونات PNG بمقاساتها الفعلية ومسارات صحيحة', () => {
  const pngIcons = icons.filter(icon => icon.type === 'image/png');
  assert(pngIcons.length >= 3, 'the manifest must declare the PNG icons');

  for (const icon of pngIcons) {
    const src = typeof icon.src === 'string' ? icon.src : '';
    assert(src.startsWith('/icons/'), `a PNG icon is served from /icons: ${src}`);
    assert(src.endsWith('.png'), `a PNG icon points at a .png file: ${src}`);
    const file = publicFile(src);
    assert.equal(existsSync(join(PUBLIC_DIR, file)), true, `the declared icon exists: ${src}`);

    // الحجم المعلن يجب أن يطابق البكسل الفعلي، وإلا رفض المتصفح الأيقونة.
    const { width, height } = readPngSize(file);
    assert.equal(icon.sizes, `${width}x${height}`, `${src}: declared sizes match the real pixels`);
  }

  assert(
    pngIcons.some(icon => icon.sizes === '192x192' && (icon.purpose || '').includes('any')),
    'a 192x192 PNG icon is declared',
  );
  assert(
    pngIcons.some(icon => icon.sizes === '512x512' && (icon.purpose || '').includes('any')),
    'a 512x512 PNG icon is declared',
  );
  assert(
    pngIcons.some(icon => icon.sizes === '512x512' && (icon.purpose || '') === 'maskable'),
    'the maskable PNG icon is kept with its purpose',
  );

  const svgIcons = icons.filter(icon => icon.type === 'image/svg+xml');
  assert(svgIcons.length >= 1, 'the scalable source icon is still declared');
  for (const icon of svgIcons) {
    const file = publicFile(String(icon.src || ''));
    assert.equal(existsSync(join(PUBLIC_DIR, file)), true, `the declared svg exists: ${icon.src}`);
    assert.equal(readFileSync(join(PUBLIC_DIR, file), 'utf8').includes('<svg'), true, `${file} is a real svg`);
  }
});

test('apple-touch-icon ملف PNG بمقاس 180×180', () => {
  const match = /<link rel="apple-touch-icon" href="([^"]+)"[^>]*>/.exec(indexHtml);
  assert(match !== null, 'the apple touch icon link carries an href');
  const href = match[1];
  assert.equal(href, '/icons/apple-touch-icon-180.png', 'the link points at the 180 png');
  assert.equal(indexHtml.includes('sizes="180x180"'), true, 'the link declares 180x180');

  const { width, height } = readPngSize(publicFile(href));
  assert.equal(width, 180);
  assert.equal(height, 180);
});

test('لا رابط إلى ملف غير موجود في index.html أو manifest', () => {
  const linked = new Set<string>();
  for (const icon of icons) {
    if (typeof icon.src === 'string') linked.add(publicFile(icon.src));
  }
  const appleIcon = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(indexHtml)?.[1];
  if (appleIcon) linked.add(publicFile(appleIcon));
  const manifestHref = /<link rel="manifest" href="([^"]+)"/.exec(indexHtml)?.[1];
  if (manifestHref) linked.add(publicFile(manifestHref));
  const favicon = /<link rel="icon"[^>]*href="([^"]+)"/.exec(indexHtml)?.[1];
  if (favicon) linked.add(publicFile(favicon));

  assert(linked.size >= 4, 'the icon links are found in the html and the manifest');
  for (const file of linked) {
    assert.equal(existsSync(join(PUBLIC_DIR, file)), true, `no link may point at a missing file: ${file}`);
  }
});

test('بيانات Apple Web App', () => {
  assert.equal(indexHtml.includes('apple-mobile-web-app-capable" content="yes"'), true, 'standalone mode');
  assert.equal(
    indexHtml.includes('apple-mobile-web-app-status-bar-style" content="black-translucent"'),
    true,
    'the status bar is configured',
  );
  assert.equal(indexHtml.includes('apple-mobile-web-app-title" content="آني"'), true, 'the home-screen name');
  assert.equal(indexHtml.includes('name="theme-color" content="#0b0b0c"'), true, 'the browser theme colour');
  assert.equal(indexHtml.includes('mobile-web-app-capable'), true, 'the cross-browser standalone hint');
});

test('مصدر الشعار محفوظ: مربع #FF3C00 وكلمة «آني» في المتجه', () => {
  const anySource = read(PUBLIC_DIR, 'icons/icon.svg');
  const maskableSource = read(PUBLIC_DIR, 'icons/icon-maskable.svg');

  for (const [name, source] of [['icon.svg', anySource], ['icon-maskable.svg', maskableSource]] as const) {
    assert(source.includes('#FF3C00'), `${name} keeps the brand colour`);
    assert(source.includes('>آني</text>'), `${name} draws the «آني» wordmark`);
    assert(source.includes('viewBox='), `${name} is a scalable vector`);
    assert(/font-weight="(700|800|900)"/.test(source), `${name} keeps the bold wordmark weight`);
  }

  assert(/<rect[^>]*rx="40"/.test(anySource), 'the standard icon has rounded corners');
  assert(!/<rect[^>]*rx=/.test(maskableSource), 'the maskable icon is full-bleed');
});

test('صفحة التطبيق تعلن اللغة والاتجاه المطابقين للـmanifest', () => {
  assert.equal(indexHtml.includes('lang="ar"'), true);
  assert.equal(indexHtml.includes('dir="rtl"'), true);
});
