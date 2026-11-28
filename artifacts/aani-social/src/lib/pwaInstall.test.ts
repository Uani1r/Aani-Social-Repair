import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * تثبيت آني على iPhone: Web App Manifest مربوط من index.html، وبيانات Apple
 * Web App، وأيقونات موجودة فعلاً في public/ (لا مسار مخترع ولا حجم مزعوم).
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

test('أيقونات Manifest موجودة فعلاً وبأنواعها الصحيحة', () => {
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  assert(icons.length >= 1, 'the manifest must declare icons');

  for (const icon of icons) {
    const src = typeof icon.src === 'string' ? icon.src : '';
    assert(src.startsWith('/'), `an icon path is rooted: ${src}`);
    const file = join(PUBLIC_DIR, src.replace(/^\/+/, ''));
    assert.equal(existsSync(file), true, `the icon file must exist: ${src}`);
    const content = readFileSync(file, 'utf8');
    assert(content.includes('<svg'), `the icon must be a real svg: ${src}`);
    assert.equal(typeof icon.sizes === 'string' && icon.sizes.length > 0, true, `an icon needs sizes: ${src}`);
  }

  const purposes = icons.map(icon => icon.purpose || '');
  assert(purposes.some(purpose => purpose.includes('any')), 'an "any" icon is declared');
  assert(purposes.some(purpose => purpose.includes('maskable')), 'a maskable icon is declared');
  assert(
    icons.every(icon => icon.type === 'image/svg+xml'),
    'every declared icon matches the type of the file it points at',
  );
});

test('بيانات Apple Web App وأيقونة اللمس', () => {
  assert.equal(indexHtml.includes('rel="apple-touch-icon"'), true, 'the apple touch icon link must exist');
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

test('الرابط في الأيقونة لا يشير إلى ملف غائب', () => {
  const match = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(indexHtml);
  assert(match !== null, 'the apple touch icon link carries an href');
  const href = match[1];
  assert(href.startsWith('/'), 'the icon path is rooted');
  assert.equal(existsSync(join(PUBLIC_DIR, href.replace(/^\/+/, ''))), true, `the linked icon exists: ${href}`);
});

test('صفحة التطبيق تعلن اللغة والاتجاه المطابقين للـmanifest', () => {
  assert.equal(indexHtml.includes('lang="ar"'), true);
  assert.equal(indexHtml.includes('dir="rtl"'), true);
});
