import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * عقد متغيرات البناء العامة لحماية الدخول.
 *
 * المانع الذي أدى إلى هذا الاختبار: قيمتان عامتان تُحشيان في حزمة الواجهة عند
 * البناء (مفتاح Turnstile العام وعناوين OAuth الإضافية). Render يمرّر متغيرات
 * الخدمة كـbuild args إلى Docker، لكن **لا تصل إلى البناء إلا إذا عرّف
 * Dockerfile لها ARG ومرّرها في ENV**. غياب ARG يعني موقعاً منشوراً بلا
 * CAPTCHA وبلا عنوان عودة إضافي، بلا أي خطأ ظاهر. هذا الاختبار يمنع تكرار ذلك.
 */

const LIB_DIR = fileURLToPath(new URL('.', import.meta.url));
const APP_DIR = join(LIB_DIR, '..', '..');
const REPO_ROOT = join(APP_DIR, '..', '..');

const REQUIRED_BUILD_VARS = ['VITE_TURNSTILE_SITE_KEY', 'VITE_AUTH_ALLOWED_ORIGINS'];

const read = (...segments: string[]): string => readFileSync(join(...segments), 'utf8');

const dockerfile = read(REPO_ROOT, 'Dockerfile');
const renderYaml = read(REPO_ROOT, 'render.yaml');
const viteConfig = read(APP_DIR, 'vite.config.ts');
const authPage = read(APP_DIR, 'src/pages/AuthPage.tsx');
const oauthRedirect = read(APP_DIR, 'src/lib/oauthRedirect.ts');

test('Dockerfile يعرّف ARG ويمرّر القيمتين إلى بيئة بناء Vite', () => {
  for (const name of REQUIRED_BUILD_VARS) {
    assert.equal(
      dockerfile.includes(`ARG ${name}=`),
      true,
      `Dockerfile must declare ARG ${name} (otherwise Render's value never reaches the build)`,
    );
    assert.equal(
      dockerfile.includes(`${name}=$${name}`),
      true,
      `Dockerfile must pass ${name} into ENV before the Vite build`,
    );
  }

  // التعريف والتمرير يجب أن يسبقا أمر بناء الواجهة، وإلا بُني الموقع بلا القيم.
  const buildIndex = dockerfile.indexOf('pnpm --filter @workspace/aani-social run build');
  assert.notEqual(buildIndex, -1, 'the Dockerfile must build the front end');
  for (const name of REQUIRED_BUILD_VARS) {
    assert(dockerfile.indexOf(`ARG ${name}=`) < buildIndex, `ARG ${name} must precede the build`);
    assert(dockerfile.indexOf(`${name}=$${name}`) < buildIndex, `${name} must be in ENV before the build`);
  }
});

test('Dockerfile لا يحمل أي سر ولا أي قيمة مخترعة', () => {
  for (const secret of [
    'TURNSTILE_SECRET_KEY',
    'LOGIN_RATE_LIMIT_HMAC_SECRET',
    'SUPABASE_SERVICE_ROLE_KEY',
    'IMAGEKIT_PRIVATE_KEY',
    'FCM_SERVICE_ACCOUNT',
  ]) {
    assert.equal(dockerfile.includes(secret), false, `Dockerfile must not mention ${secret}`);
  }

  // ARG بلا قيمة = لا ادعاء بقيمة: القيمة تأتي من لوحة Render وحدها.
  for (const name of REQUIRED_BUILD_VARS) {
    assert.equal(
      new RegExp(`ARG ${name}=(?=\\n)`).test(dockerfile),
      true,
      `ARG ${name} must stay empty so no value is invented in the image`,
    );
  }
});

test('render.yaml يعرض القيمتين كإعدادين مطلوبين من المالك بلا قيمة', () => {
  for (const name of REQUIRED_BUILD_VARS) {
    assert.equal(renderYaml.includes(`- key: ${name}`), true, `render.yaml must declare ${name}`);
    assert.equal(
      new RegExp(`- key: ${name}\\n\\s+sync: false`).test(renderYaml),
      true,
      `${name} must be marked sync: false (set by the owner in the dashboard)`,
    );
    assert.equal(
      new RegExp(`- key: ${name}\\n\\s+value:`).test(renderYaml),
      false,
      `${name} must not carry a value in render.yaml`,
    );
  }
});

test('vite.config.ts يعدّ القيمتين من مفاتيح البناء العامة', () => {
  const list = viteConfig.slice(
    viteConfig.indexOf('const PUBLIC_ENV_KEYS'),
    viteConfig.indexOf('] as const;'),
  );
  for (const name of REQUIRED_BUILD_VARS) {
    assert.equal(list.includes(`'${name}'`), true, `${name} must be a PUBLIC_ENV_KEYS entry`);
  }
});

test('الواجهة تقرأ المفتاح العام وحده ولا تدّعي أن CAPTCHA جاهزة بلا مفتاح', () => {
  // المفتاح العام يُقرأ من import.meta.env (قيمة تُحشى عند البناء).
  assert.equal(
    authPage.includes('import.meta.env.VITE_TURNSTILE_SITE_KEY'),
    true,
    'the client must read the public site key from the build env',
  );
  // لا سر CAPTCHA في العميل، ولا في أي ملف يُحشى في الحزمة.
  for (const source of [authPage, oauthRedirect, viteConfig]) {
    assert.equal(source.includes('TURNSTILE_SECRET_KEY'), false, 'the Turnstile secret must never reach the client');
  }

  // بلا مفتاح: لا ودجت ولا بدء للمسارين المحميين، ورسالة صريحة بدل ادعاء الجاهزية.
  assert.equal(
    authPage.includes('if (!TURNSTILE_SITE_KEY)'),
    true,
    'the client must refuse to start the protected paths without a site key',
  );
  assert.equal(
    authPage.includes('غير مضبوطة'),
    true,
    'the client must say that CAPTCHA is not configured',
  );

  // عنوان OAuth الإضافي يُقرأ من متغير البناء نفسه.
  assert.equal(
    oauthRedirect.includes('VITE_AUTH_ALLOWED_ORIGINS'),
    true,
    'the redirect allow-list must come from the build env',
  );
});
