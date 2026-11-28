import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(join(SRC_ROOT, 'pages/not-found.tsx'), 'utf8');

/**
 * صفحة 404 ظهرت بنص داكن على خلفية داكنة (ألوان فاتحة مفروضة داخل سمة
 * داكنة). لا يمكن اختبار التباين بصرياً هنا، فيُختبر المصدر: لا لوحة ألوان
 * فاتحة مفروضة، ونصوص وخلفية محددة، ومسارا عودة واضحان.
 */
test('صفحة 404 لا تفرض لوحة ألوان فاتحة', () => {
  for (const lightClass of ['bg-gray-50', 'bg-gray-100', 'text-gray-900', 'text-gray-600']) {
    assert.equal(source.includes(lightClass), false, `no forced light class: ${lightClass}`);
  }
});

test('صفحة 404: خلفية داكنة ونص مقروء', () => {
  assert.equal(source.includes('bg-[#0b0b0c]'), true, 'dark page background');
  assert.equal(source.includes('bg-[#141414]'), true, 'dark card background');
  assert.equal(source.includes('text-[#f5f5f5]'), true, 'light heading text');
  assert.equal(source.includes('text-[#a1a1a6]'), true, 'readable muted text');
  assert.equal(source.includes('dir="rtl"'), true, 'right-to-left layout');
});

test('صفحة 404: رسالة عربية وزرّا عودة', () => {
  assert.equal(source.includes('الصفحة غير موجودة'), true, 'Arabic heading');
  assert.equal(source.includes('href="/"'), true, 'home action');
  assert.equal(source.includes('href="/login"'), true, 'sign-in action');
  // لا نص تقني عن الراوتر للزائر.
  assert.equal(/Did you forget/i.test(source), false, 'no developer text');
});
