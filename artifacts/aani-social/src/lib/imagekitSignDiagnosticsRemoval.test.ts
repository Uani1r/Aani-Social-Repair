import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const srcRoot = new URL('..', import.meta.url);

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, srcRoot)), 'utf8');
}

function exists(relativePath: string): boolean {
  return existsSync(fileURLToPath(new URL(relativePath, srcRoot)));
}

test('the temporary ImageKit signing diagnostics tool is removed', () => {
  const app = read('./App.tsx');
  assert.equal(app.includes('ImageKitSignDiagnostics'), false);
  assert.equal(app.includes('اختبار توقيع ImageKit'), false);
  assert.equal(app.includes('ImageKitSignCheckResult'), false);

  assert.equal(exists('./components/ImageKitSignDiagnostics.tsx'), false);
  assert.equal(exists('./lib/imagekitSignCheck.ts'), false);
  assert.equal(exists('../docs/IMAGEKIT_SIGN_TEST_AR.md'), false);
});

test('the core ImageKit signing path is untouched', () => {
  const mediaAccess = read('./lib/mediaAccess.ts');
  assert.equal(mediaAccess.includes('export function isImageKitSigningEnabled'), true);
  assert.equal(mediaAccess.includes('export function parseImageKitPath'), true);

  // تشخيص فشل النشر ما زال يستخدم حالة تفعيل التوقيع نفسها.
  const publishDiagnostics = read('./lib/publishDiagnostics.ts');
  assert.equal(publishDiagnostics.includes('isImageKitSigningEnabled'), true);
});
