/**
 * واجهة الحساب الرسمي للنشر والإعلانات والتنبيهات.
 *
 * تُعرض للحساب الرسمي (والمؤسس والمسؤول). لا تمنح أي صلاحيات مؤسسية أو
 * إدارية عليا. عمليات النشر تُسلم إلى خادم مؤمن (قيد الربط).
 */

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCoreAccount } from '../hooks/useCoreAccount';
import { isOfficialPanelAllowed } from '../official/guard';
import { coreOfficialCreatePost, coreOfficialSendAnnouncement } from '../official/service';
import type { CoreAccountRole } from '../types/account';

export default function OfficialComposer() {
  const { role, isOfficial, loading, error, refetch } = useCoreAccount();
  const [postContent, setPostContent] = useState('');
  const [announceContent, setAnnounceContent] = useState('');

  const isPanelAllowed = isOfficialPanelAllowed(role as CoreAccountRole | null);

  const handleRefresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  if (loading) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader><CardTitle>جاري التحقق من صلاحية الحساب الرسمي...</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-2">
          <span className="animate-spin rounded-full border-2 border-current h-5 w-5" />
        </CardContent>
      </Card>
    );
  }

  if (!isPanelAllowed) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader><CardTitle>واجهة الحساب الرسمي</CardTitle></CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertTitle>غير مصرح بالدخول</AlertTitle>
            <AlertDescription>هذه الواجهة محصورة في الحساب الرسمي والمسؤول والمؤسس فقط. دورك الحالي: {role ?? 'غير محدد'}.</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const handleCreatePost = useCallback(async () => {
    if (!postContent.trim()) return;
    const res = await coreOfficialCreatePost({
      content: postContent,
      actorRole: role,
      reason: 'منشور رسمي من واجهة الحساب الرسمي',
    });
    if (res.ok) {
      setPostContent('');
      alert('تم إنشاء المنشور الرسمي (تجريبي)');
    } else {
      alert(res.error?.message || 'فشل إنشاء المنشور');
    }
  }, [postContent, role]);

  const handleSendAnnouncement = useCallback(async () => {
    if (!announceContent.trim()) return;
    const res = await coreOfficialSendAnnouncement({
      content: announceContent,
      actorRole: role,
      reason: 'إعلان رسمي من واجهة الحساب الرسمي',
    });
    if (res.ok) {
      setAnnounceContent('');
      alert('تم إرسال الإعلان (تجريبي)');
    } else {
      alert(res.error?.message || 'فشل إرسال الإعلان');
    }
  }, [announceContent, role]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>واجهة الحساب الرسمي</CardTitle>
          <p className="text-sm text-muted-foreground">
            للنشر والإعلانات والتنبيهات الرسمية ({'ilawyerm.a.a@gmail.com'}).
            لا صلاحيات مؤسس أو إدارة عليا.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold">الدور</div>
              <div className="text-sm text-muted-foreground">{role}</div>
            </div>
            <Badge variant={isOfficial ? 'default' : 'secondary'}>{role}</Badge>
          </div>
          <Button onClick={handleRefresh}>تحديث الحالة</Button>
        </CardContent>
      </Card>

      <div className="grid sm:grid-cols-2 gap-3">
        <Card>
          <CardHeader><CardTitle>إنشاء منشور رسمي</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Label>نص المنشور</Label>
            <Textarea value={postContent} onChange={(e) => setPostContent(e.target.value)} rows={3} placeholder="اكتب المنشور الرسمي..." />
            <Button onClick={handleCreatePost} disabled={!postContent.trim()}>
              نشر منشور رسمي
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>إعلان رسمي</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Label>محتوى الإعلان</Label>
            <Input value={announceContent} onChange={(e) => setAnnounceContent(e.target.value)} placeholder="محتوى الإعلان..." />
            <Button onClick={handleSendAnnouncement} disabled={!announceContent.trim()}>
              إرسال إعلان
            </Button>
          </CardContent>
        </Card>
      </div>

      <Alert variant="default">
        <AlertTitle>حدود الصلاحية</AlertTitle>
        <AlertDescription>
          هذا الحساب لا يصل إلى لوحة المؤسس ولا لوحة الإدارة، ولا يمكنه تغيير أي دور أو
          الوصول إلى العمليات المالية. جميع العمليات تُسجل في سجل التدقيق.
        </AlertDescription>
      </Alert>

      {error && <Alert variant="destructive"><AlertTitle>خطأ</AlertTitle><AlertDescription>{error.message}</AlertDescription></Alert>}
    </div>
  );
}
