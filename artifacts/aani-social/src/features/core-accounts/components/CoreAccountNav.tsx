/**
 * عنصر تنقل للحسابات الأساسية.
 *
 * يُعرض فقط للأدوار المسموحة (المؤسس/المسؤول للحساب العام، والحساب الرسمي
 * لواجهته). الربط الفعلي بالمسارات يحدث في App.tsx؛ هذا العنصر يوفر مداخل
 * سريعة تُShown وفقًا للدور المحلول من الخادم.
 */

import { Link } from 'wouter';
import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useCoreAccount } from '../hooks/useCoreAccount';

export default function CoreAccountNav() {
  const { role, isFounder, isAdmin, isOfficial, loading } = useCoreAccount();

  if (loading) return null;

  const items = [
    { label: 'لوحة المؤسس', href: '/core/founder', allowed: isFounder },
    { label: 'لوحة الإدارة', href: '/core/admin', allowed: isFounder || isAdmin },
    { label: 'الحساب الرسمي', href: '/core/official', allowed: isFounder || isAdmin || isOfficial },
  ].filter((item) => item.allowed);

  if (items.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <Button key={item.href} asChild variant="outline" size="sm" className="w-full text-left">
          <Link href={item.href}>{item.label}</Link>
        </Button>
      ))}
    </div>
  );
}
