import assert from 'node:assert/strict';
import test from 'node:test';

import {
  coreHasPermission,
  coreCanAccessFounderPanel,
  coreCanAccessAdminPanel,
  coreCanAccessOfficialPanel,
  coreCanAccessFounderFinancial,
  coreCanManageRoles,
  corePermissionsForRole,
  coreIsForbiddenForNonFounder,
  coreRoleGte,
  coreRoleRank,
  CORE_FOUNDER_ONLY_PERMISSIONS,
  CORE_PERMISSIONS,
  CORE_ROLE_HIERARCHY,
} from '../roles/definitions';
import type { CoreAccountRole, CorePermissionKey } from '../types/account';

const roles: CoreAccountRole[] = ['founder', 'admin', 'official', 'user'];

test('الأدوار مرتبة تصاعديًا: founder > admin > official > user', () => {
  assert.deepEqual(CORE_ROLE_HIERARCHY, [
    'founder',
    'admin',
    'official',
    'user',
  ]);
  assert.equal(coreRoleRank('founder'), 4);
  assert.equal(coreRoleRank('admin'), 3);
  assert.equal(coreRoleRank('official'), 2);
  assert.equal(coreRoleRank('user'), 1);
  assert.ok(coreRoleGte('admin', 'official'));
  assert.ok(coreRoleGte('founder', 'admin'));
  assert.ok(!coreRoleGte('official', 'admin'));
  assert.ok(!coreRoleGte('user', 'founder'));
});

test('المؤسس يمتلك كل الصلاحيات including المالية وإدارة الأدوار', () => {
  const founderPerms = corePermissionsForRole('founder');
  for (const key of ['core.founder.financial.read', 'core.founder.financial.write', 'core.founder.roles.manage', 'core.accounts.write']) {
    assert.ok(founderPerms.has(key as CorePermissionKey), `المؤسس يجب أن يملك ${key}`);
  }
});

test('المؤسس يستطيع الوصول إلى صلاحياته المسموحة (لوحة المؤسس والمالية)', (t) => {
  assert.ok(coreCanAccessFounderPanel('founder'));
  assert.ok(coreCanAccessFounderFinancial('founder'));
  assert.ok(coreCanManageRoles('founder'));
  assert.ok(coreHasPermission('founder', 'core.founder.financial.write'));
  assert.ok(coreHasPermission('founder', 'core.admin.users.manage'));
});

test('الإدارة لا تستطيع الوصول إلى العمليات المالية الحساسة للمؤسس', () => {
  assert.ok(!coreCanAccessFounderPanel('admin'));
  assert.ok(!coreCanAccessFounderFinancial('admin'));
  assert.ok(!coreCanManageRoles('admin'));
  assert.ok(!coreHasPermission('admin', 'core.founder.financial.write'));
  assert.ok(!coreHasPermission('admin', 'core.founder.roles.manage'));
  assert.ok(!coreHasPermission('admin', 'core.accounts.write'));
});

test('الحساب الرسمي لا يستطيع الوصول إلى لوحة الإدارة أو المؤسس', () => {
  assert.ok(!coreCanAccessFounderPanel('official'));
  assert.ok(!coreCanAccessAdminPanel('official'));
  assert.ok(coreCanAccessOfficialPanel('official'));
  assert.ok(!coreHasPermission('official', 'core.admin.users.manage'));
  assert.ok(!coreHasPermission('official', 'core.founder.financial.read'));
});

test('المستخدم العادي لا يستطيع انتحال أي دور', () => {
  assert.ok(!coreCanAccessFounderPanel('user'));
  assert.ok(!coreCanAccessAdminPanel('user'));
  assert.ok(!coreCanAccessOfficialPanel('user'));
  assert.ok(!coreHasPermission('user', 'core.admin.users.manage'));
  assert.ok(!coreHasPermission('user', 'core.official.posts.create'));
});

test('لا يمكن تغيير الأدوار من الواجهة أو من طلبات العميل (المنطق خالص وغير قابل للتعديل)', () => {
  // خريطة الصلاحيات مجمدة: لا دالة لتعديلها في الوحدة.
  assert.ok(Object.isFrozen(CORE_PERMISSIONS), 'قائمة الصلاحيات يجب أن تكون مجمدة');
  assert.ok(
    CORE_FOUNDER_ONLY_PERMISSIONS.has('core.founder.financial.write'),
    'الصلاحية المالية محصورة في المؤسس',
  );
  assert.ok(
    CORE_FOUNDER_ONLY_PERMISSIONS.has('core.founder.roles.manage'),
    'إدارة الأدوار محصورة في المؤسس',
  );
  assert.ok(
    CORE_FOUNDER_ONLY_PERMISSIONS.has('core.accounts.write'),
    'كتابة الحسابات الأساسية محصورة في المؤسس',
  );
});

test('أي دور غير مؤسس يُرفض عند محاولة الوصول لصلاحيات المؤسس المحظورة', () => {
  for (const role of ['admin', 'official', 'user']) {
    for (const key of CORE_FOUNDER_ONLY_PERMISSIONS) {
      assert.ok(coreIsForbiddenForNonFounder(role, key as CorePermissionKey), `${role} يجب أن يُمنع من ${key}`);
      assert.ok(!coreIsForbiddenForNonFounder('founder', key as CorePermissionKey));
    }
  }
});

test('أدوار الحسابات الثلاثة موثقة ولا تتعارض', () => {
  const expected = new Map([
    ['anilaw2000@gmail.com', 'founder'],
    ['ani.mohammed2000@gmail.com', 'admin'],
    ['ilawyerm.a.a@gmail.com', 'official'],
  ]);
  assert.equal(expected.size, 3);
  for (const [email, role] of expected) {
    assert.ok(roles.includes(role), `البريد ${email} يطابق دورًا معروفًا: ${role}`);
  }
  // البريدان admin و official غير متساويين مع مؤسس ولا مع بعضهما.
  assert.notEqual(expected.get('ani.mohammed2000@gmail.com'), expected.get('anilaw2000@gmail.com'));
  assert.notEqual(expected.get('ilawyerm.a.a@gmail.com'), expected.get('anilaw2000@gmail.com'));
});
