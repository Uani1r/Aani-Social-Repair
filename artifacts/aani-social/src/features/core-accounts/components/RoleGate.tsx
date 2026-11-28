/**
 * مكون حماية حسب الدور.
 *
 * يعرض الأبناء فقط عندما يُرجع الشرط true؛ وإلا يعرض واجهة رفض عامة (غير
 * قابلة للتجاوز من العميل). يُستخدم في الواجهة لتقليل الارتباك، وليس كبديل
 * عن التحقق الخادمي.
 */

import { useCallback } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type RoleGateProps = {
  allowed: boolean;
  reason?: string;
  children?: React.ReactNode;
  fallback?: React.ReactNode;
};

export function RoleGate({ allowed, reason, children, fallback }: RoleGateProps) {
  const renderForbidden = useCallback(() => {
    if (fallback) return fallback;
    return (
      <Alert variant="destructive" className="rounded-lg border-red-500/20">
        <AlertTitle>غير مصرح لك بهذه العملية</AlertTitle>
        <AlertDescription>{reason || 'الدور الحالي لا يحمل هذه الصلاحية.'}</AlertDescription>
      </Alert>
    );
  }, [fallback, reason]);

  if (!allowed) return renderForbidden();
  return <>{children}</>;
}

export default RoleGate;
