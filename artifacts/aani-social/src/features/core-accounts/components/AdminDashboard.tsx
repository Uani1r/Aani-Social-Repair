/**
 * لوحة إدارة يومية لحساب Admin.
 *
 * تُعرض للمسؤول (والمؤسس). تمنع أي عملية تمنح صلاحيات المؤسس أو تعدل جدول
 * المؤسسين؛ العمليات تُسلم إلى خدمات admin المؤمنة (قيد الربط بالخادم).
 */

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useCoreAccount } from '../hooks/useCoreAccount';
import { isAdminPanelAllowed, isAdminActionAllowed } from '../admin/guard';
import { coreAdminBanUser, coreAdminModerateContent, coreAdminReadAudit } from '../admin/service';
import type { CoreAccountRole } from '../types/account';

export default function AdminDashboard() {
  const { role, isAdmin, loading, error, refetch } = useCoreAccount();

  const isPanelAllowed = isAdminPanelAllowed(role as CoreAccountRole | null);
  const canBan = isAdminActionAllowed(role as CoreAccountRole | null, 'core.admin.users.manage');
  const canModerate = isAdminActionAllowed(role as CoreAccountRole | null, 'core.admin.content.moderate');
  const canReadAudit = isAdminActionAllowed(role as CoreAccountRole | null, 'core.admin.audit.read');

  const handleRefresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  if (loading) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader><CardTitle>جاري التحقق من صلاحية الإدارة...</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-2">
          <span className="animate-spin rounded-full border-2 border-current h-5 w-5" />
        </CardContent>
      </Card>
    );
  }

  if (!isPanelAllowed) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader><CardTitle>لوحة الإدارة اليومية</CardTitle></CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertTitle>غير مصرح بالدخول</AlertTitle>
            <AlertDescription>هذه اللوحة محصورة في المؤسس والمسؤول فقط. دورك الحالي: {role ?? 'غير محدد'}.</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>لوحة الإدارة اليومية</CardTitle>
          <p className="text-sm text-muted-foreground">
            للمؤسس والمسؤول ({'ani.mohammed2000@gmail.com'}). ممنوع من صلاحيات المؤسس المالية.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold">الدور</div>
              <div className="text-sm text-muted-foreground">{role}</div>
            </div>
            <Badge variant={isAdmin ? 'default' : 'secondary'}>{role}</Badge>
          </div>
          <Button onClick={handleRefresh}>تحديث الحالة</Button>
        </CardContent>
      </Card>

      <div className="grid sm:grid-cols-2 gap-3">
        <Card>
          <CardHeader><CardTitle>إدارة المستخدمين</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <RolePermissionChip allowed={canBan} permission="إدارة المستخدمين" />
            <Button onClick={() => void coreAdminBanUser({ userId: '', actorRole: role, reason: 'اختبار من لوحة الإدارة' })} disabled={!canBan}>
              تنفيذ إجراء تجريبي (معلق الربط)
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>البلاغات والإشراف</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <RolePermissionChip allowed={canModerate} permission="الإشراف على المحتوى" />
            <Button onClick={() => void coreAdminModerateContent({ targetType: 'post', targetId: '', action: 'hide', reason: 'اختبار الإشراف', actorRole: role })} disabled={!canModerate}>
              إشراف تجريبي (معلق الربط)
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>سجل التدقيق الإداري</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <RolePermissionChip allowed={canReadAudit} permission="قراءة التدقيق" />
          <Button onClick={() => void coreAdminReadAudit({ actorRole: role })} disabled={!canReadAudit}>
            جلب السجل (معلق الربط)
          </Button>
        </CardContent>
      </Card>

      <Alert variant="destructive">
        <AlertTitle>حدود الصلاحية</AlertTitle>
        <AlertDescription>
          لا يمكن لهذا الحساب الوصول إلى العمليات المالية للمؤسس، ولا تعديل جدول المؤسسين
          (sandbox.founders)، ولا تغيير دور أي مؤسس. أي محاولة تُسجل وتُرفض من الخادم.
        </AlertDescription>
      </Alert>

      {error && <Alert variant="destructive"><AlertTitle>خطأ</AlertTitle><AlertDescription>{error.message}</AlertDescription></Alert>}
    </div>
  );
}

function RolePermissionChip({ allowed, permission }: { allowed: boolean; permission: string }) {
  return (
    <div className="flex items-center gap-2 text-xs mb-1">
      <Badge variant={allowed ? 'default' : 'secondary'}>{allowed ? 'مسموح' : 'ممنوع'}</Badge>
      <span className="text-muted-foreground">{permission}</span>
    </div>
  );
}
