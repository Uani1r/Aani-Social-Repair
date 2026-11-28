import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * حارس إدارة أسماء المستخدمين: البنية الخلفية وحدها تملك قرار الحجز والمنع.
 *
 * ما يثبته هذا الاختبار من المصادر:
 *   * العميل لا يقرأ ولا يكتب `username_registry` مباشرة (لا REST).
 *   * لا صلاحية إدارة تُشتق من `user_metadata`/`app_metadata` في العميل.
 *   * العميل لا يكتب أعمدة التسجيل والموافقة بنفسه: دالة ذرية واحدة تفعل.
 *   * الترحيل يسحب صلاحيات الجدول من anon وauthenticated، ويشغّل RLS، ويسجّل
 *     التدقيق، وينشئ دوال المطالبة والحالة والإكمال.
 *
 * هذا ليس اختبار قاعدة بيانات: سلوك SQL الفعلي (الحجز، التزامن، RLS) يغطيه
 * اختبار psql المنفصل supabase/tests/username_registry_onboarding.test.sql.
 */

const LIB_DIR = fileURLToPath(new URL('.', import.meta.url));
const SRC_DIR = join(LIB_DIR, '..');
const APP_DIR = join(LIB_DIR, '..', '..');
const SUPABASE_DIR = join(APP_DIR, 'supabase');

const read = (...segments: string[]): string => readFileSync(join(...segments), 'utf8');

const CLIENT_SOURCES = [
  'App.tsx',
  'hooks/useAppSession.ts',
  'lib/authGate.ts',
  'lib/onboarding.ts',
  'lib/profileCompletion.ts',
  'lib/usernameRules.ts',
  'lib/usernameAvailability.ts',
  'pages/AuthPage.tsx',
  'pages/OnboardingPage.tsx',
  'pages/ProfilePage.tsx',
  'components/auth/ProfileFormFields.tsx',
];

const client = CLIENT_SOURCES.map(path => ({ path, source: read(SRC_DIR, path) }));

// ملفات الكتابة في العميل وحدها: القراءة عبر الدالة في lib/onboarding.ts
// مشروعة، والكتابة على العمودين ممنوعة هنا.
const WRITE_SOURCES = [
  'App.tsx',
  'pages/AuthPage.tsx',
  'pages/OnboardingPage.tsx',
  'pages/ProfilePage.tsx',
  'components/auth/ProfileFormFields.tsx',
];

const migration = read(SUPABASE_DIR, 'migrations/20270314000000_profile_onboarding_and_username_registry.sql');

test('العميل لا يلمس سجل الأسماء مباشرة', () => {
  for (const { path, source } of client) {
    assert.equal(/from\(['"]username_registry['"]\)/.test(source), false, `${path} must not query the registry`);
    assert.equal(/username_registry_audit/.test(source), false, `${path} must not read the audit log`);
    assert.equal(/\.from\(['"]username_registry['"]\)\s*\.(insert|update|delete|upsert)/.test(source), false, path);
  }
});

test('لا صلاحية إدارة من بيانات المستخدم القابلة للتعديل', () => {
  for (const { path, source } of client) {
    for (const pattern of [
      /is_admin/i,
      /user_metadata\s*\?\??\.\s*role/i,
      /app_metadata\s*\?\??\.\s*role/i,
      /app_metadata\s*\?\??\.\s*is_admin/i,
      /\bisAdmin\b/,
    ]) {
      assert.equal(pattern.test(source), false, `${path} must not read an admin flag from client metadata`);
    }
  }

  // التمييز الإداري في قاعدة البيانات هو actor_kind، ولا يأتي من العميل.
  assert.equal(/actor_kind/.test(migration), true, 'the audit trail must record who acted');
  assert.equal(/actor_kind in \('system', 'user', 'admin'\)/.test(migration), true, 'the actor kinds are fixed');
});

test('أعمدة التسجيل والموافقة تُكتب من الدالة الذرية وحدها', () => {
  for (const path of WRITE_SOURCES) {
    const source = read(SRC_DIR, path);
    assert.equal(/onboarding_completed_at\s*:/.test(source), false, `${path} must not write the completion column`);
    assert.equal(/terms_accepted_at\s*:/.test(source), false, `${path} must not write the consent timestamp`);
    assert.equal(/insert into public\.profiles/i.test(source), false, path);
  }

  // الشرح: القراءة عبر الدالة، والكتابة عبر aani_complete_onboarding.
  assert.equal(/rpc\(\s*['"]aani_complete_onboarding['"]/.test(read(SRC_DIR, 'lib/profileCompletion.ts')), true);
  assert.equal(/rpc\(\s*['"]aani_my_onboarding_state['"]/.test(read(SRC_DIR, 'lib/onboarding.ts')), true);
});

test('الترحيل: RLS وسحب الصلاحيات وسجل تدقيق ودوال ذرية', () => {
  // لا وصول مباشر لسجل الأسماء ولا للسجل التدقيقي.
  assert.equal(/alter table public\.username_registry enable row level security/.test(migration), true);
  assert.equal(/alter table public\.username_registry_audit enable row level security/.test(migration), true);
  assert.equal(
    /revoke all on table public\.username_registry from public, anon, authenticated/.test(migration),
    true,
    'authenticated must not modify registry rows',
  );
  assert.equal(
    /revoke all on table public\.username_registry_audit from public, anon, authenticated/.test(migration),
    true,
    'no client role may read or write the audit log',
  );
  for (const forbidden of [
    /grant (select|insert|update|delete)[^;]*on (table )?public\.username_registry[^;]*to (anon|authenticated)/,
    /grant (select|insert|update|delete)[^;]*on (table )?public\.username_registry_audit[^;]*to (anon|authenticated)/,
  ]) {
    assert.equal(forbidden.test(migration), false, 'no registry privilege may be granted to a client role');
  }

  // الحالات الأربع، والاشتقاق من المالك.
  for (const state of ['available', 'reserved', 'blocked', 'claimed']) {
    assert.equal(migration.includes(`'${state}'`), true, `the registry must support ${state}`);
  }
  assert.equal(/reserved_until/.test(migration), true, 'a temporary reservation needs an expiry');
  assert.equal(/username_registry_one_claim_per_user_idx/.test(migration), true, 'one claimed name per account');

  // الدوال: قراءة الحالة، المطالبة، الإكمال، وقراءة حالة التسجيل.
  for (const fn of [
    'aani_normalize_username',
    'aani_username_status',
    'aani_claim_username',
    'aani_complete_onboarding',
    'aani_my_onboarding_state',
  ]) {
    assert.equal(migration.includes(`function public.${fn}`), true, `missing function ${fn}`);
  }

  // القيدان: صيغة 1–32 بحروف صغيرة، والموافقة الإلزامية.
  assert.equal(
    /username = lower\(username\) and username ~ '\^\[a-z0-9_\.\]\{1,32\}\$'/.test(migration),
    true,
    'the username check must allow 1–32 lowercase characters',
  );
  assert.equal(/terms_required/.test(migration), true, 'completion must refuse a missing consent');

  // الأسماء الحالية تُسجَّل كمملوكة، ولا تُحجز ولا تُعاد تسميتها.
  assert.equal(/backfill of existing username/.test(migration), true);
  assert.equal(/aani_schema_markers/.test(migration), true, 'the backfill must run exactly once');
});

test('صفحات الشروط والخصوصية الفعلية تُستخدم في الموافقة', () => {
  const legal = read(SRC_DIR, 'pages/legal.tsx');
  assert.equal(legal.includes("'/terms'"), true, 'a real terms path');
  assert.equal(legal.includes("'/privacy'"), true, 'a real privacy path');
  assert.equal(legal.includes('شروط الخدمة'), true, 'the existing terms title');
  assert.equal(legal.includes('سياسة الخصوصية'), true, 'the existing privacy title');

  const fields = read(SRC_DIR, 'components/auth/ProfileFormFields.tsx');
  // الرابطان يستخدمان المسارين المعرّفين في وحدة الصفحات القانونية نفسها.
  assert.equal(fields.includes('TERMS_PATH'), true, 'the consent must link the terms page');
  assert.equal(fields.includes('PRIVACY_PATH'), true, 'the consent must link the privacy page');
  assert.equal(fields.includes('type="checkbox"'), true, 'consent is an explicit checkbox');

  // الصفحتان موجودتان فعلاً في التطبيق (لا رابط إلى صفحة غير موجودة).
  const app = read(SRC_DIR, 'App.tsx');
  assert.equal(/readLegalDocumentFromPath/.test(app), true, 'the app must serve the legal pages');
  assert.equal(/LegalPage/.test(app), true, 'the legal page component must be rendered');
});
