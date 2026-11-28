/**
 * لوحة مؤسس سرية.
 *
 * لا تُعرض إلا للمؤسس (دور founder من الخادم + تأكيد sandbox.founders للصلاحية
 * المالية). جميع الأزرار المالية تُحقق في الخادم عبر دوال RPC مؤمنة قبل
 * التنفيذ؛ إخفاء الزر في الواجهة ليس حماية بحد ذاته.
 */

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useCoreAccount } from '../hooks/useCoreAccount';
import { useFounder } from '../hooks/useFounder';
import {
  isFounderPanelAllowed,
  isFounderFinancialAllowed,
  isFounderRoleManagementAllowed,
} from '../founder/guard';
import { coreGrantSandboxCoins, coreRefundSandboxTopUp } from '../founder/service';
import type { CoreAccountRole } from '../types/account';

export default function FounderPanel() {
  const { role, isFounder, loading, error, refetch } = useCoreAccount();
  const { isFounder: sandboxFounder, loading: sandboxLoading, error: sandboxError, checkFounder } = useFounder();

  const isFinancialAllowed = isFounderFinancialAllowed(role as CoreAccountRole | null);
  const isRoleMgmtAllowed = isFounderRoleManagementAllowed(role as CoreAccountRole | null);

  const handleRefresh = useCallback(async () => {
    await refetch();
    await checkFounder();
  }, [refetch, checkFounder]);

  // حالة التحميل الأولية فقط.
  if (loading || sandboxLoading) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader><CardTitle>جاري التحقق من صلاحية المؤسس...</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-2">
          <span className="animate-spin rounded-full border-2 border-current h-5 w-5" />
        </CardContent>
      </Card>
    );
  }

  // الرفض 닫 دائمًا للمؤسسين (بغض النظر عن إخفاء واجهة المستخدم).
  if (!isFounderPanelAllowed(role as CoreAccountRole | null)) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader><CardTitle>لوحة المؤسس السرية</CardTitle></CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertTitle>غير مصرح بالدخول</AlertTitle>
            <AlertDescription>هذه اللوحة محصورة في حساب المؤسس فقط. دورك الحالي: {role ?? 'غير محدد'}.</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>لوحة المؤسس السرية</CardTitle>
          <p className="text-sm text-muted-foreground">
            متاحة فقط لحساب المؤسس ({'anilaw2000@gmail.com'}). التحقق المالي من sandbox.founders.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold">حالة المؤسس المالي (sandbox.founders)</div>
              <div className="text-sm text-muted-foreground">
                {sandboxFounder === true ? 'مؤسس معتمد من الخادم' : sandboxFounder === false ? 'غير معتمد كمؤسس في السandbox' : 'غير محسوم'}
              </div>
            </div>
            <Badge variant={sandboxFounder === true ? 'default' : 'destructive'}>
              {sandboxFounder === true ? 'مؤسس' : sandboxFounder === false ? 'غير مؤسس' : '—'}
            </Badge>
          </div>
          {sandboxError && (
            <Alert variant="destructive">
              <AlertTitle>تعذر التحقق من المؤسس المالي</AlertTitle>
              <AlertDescription>{sandboxError.message}</AlertDescription>
            </Alert>
          )}
          <Button onClick={handleRefresh}>إعادة التحقق</Button>
        </CardContent>
      </Card>

      {isFinancialAllowed && (
        <Card>
          <CardHeader><CardTitle>العمليات المالية (المؤسس فقط)</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              هذه العمليات تُنفّذ عبر دوال RPC مؤمنة في الخادم، وتُسجل في سجل التدقيق.
              responsible عن التحقق النهائي هو sandbox.founders.
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              <Button onClick={() => alert('تُفتح نموذج منح العملات بعد ربط النموذج بالخادم')} disabled={!isFinancialAllowed}>
                منح عملات تجريبية
              </Button>
              <Button variant="outline" onClick={() => alert('تُفتح نموذج الاسترداد بعد ربط النموذج بالخادم')} disabled={!isFinancialAllowed}>
                استرداد شحن
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isRoleMgmtAllowed && (
        <Card>
          <CardHeader><CardTitle>إدارة الأدوار (المؤسس فقط)</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Alert variant="default">
              <AlertTitle>إدارة المؤسسين</AlertTitle>
              <AlertDescription>
                إضافة/إزالة المؤسسين تُنفّذ عبر SQL خادمي فقط؛ لا تُرسل أي ادعاء بمنصب المؤسس من المتصفح.
              </AlertDescription>
            </Alert>
            <Button disabled>{'ربط إدارة المؤسسين (قيد الانتظار)'}</Button>
          </CardContent>
        </Card>
      )}

      {!isFinancialAllowed && !isRoleMgmtAllowed && (
        <Alert variant="default">
          <AlertTitle>لا توجد إجراءات مؤسسية متاحة لدورك الحالي</AlertTitle>
          <AlertDescription>{role ? `الدور: ${role}` : 'الدور غير محسوم'}</AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>خطأ في تحميل بيانات المؤسس</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
