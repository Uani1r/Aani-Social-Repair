import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  isSandboxFounder,
  fetchSandboxLedger,
  fetchSandboxTopUps,
  fetchSandboxRefunds,
  fetchSandboxSubscriptions,
  fetchSandboxPromotions,
  fetchSandboxAdminActions,
  fetchSandboxTopUpPackages,
  fetchSandboxSubscriptionPackages,
  fetchSandboxPromotionPackages,
  grantSandboxCoins,
  refundSandboxTopUp,
  activateSandboxSubscription,
  cancelSandboxSubscription,
  renewSandboxSubscription,
  createSandboxPromotion,
  generateIdempotencyKey,
  endSandboxPromotion,
  type SandboxLedgerEntry,
  type SandboxTopUp,
  type SandboxAdminAction,
  type SandboxSubscription,
  type SandboxPromotion,
} from '@/lib/sandbox';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function AdminSandbox() {
  const [founder, setFounder] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('grants');

  const [ledger, setLedger] = useState<SandboxLedgerEntry[]>([]);
  const [topUps, setTopUps] = useState<SandboxTopUp[]>([]);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [subs, setSubs] = useState<SandboxSubscription[]>([]);
  const [promos, setPromos] = useState<SandboxPromotion[]>([]);
  const [adminActions, setAdminActions] = useState<SandboxAdminAction[]>([]);
  const [topUpPackages, setTopUpPackages] = useState<any[]>([]);
  const [subPackages, setSubPackages] = useState<any[]>([]);
  const [promoPackages, setPromoPackages] = useState<any[]>([]);

  // حقائق الإجراءات التي تتطلب معرف مستخدم/هدف صحيح
  const [subUserId, setSubUserId] = useState('');
  const [promoUserId, setPromoUserId] = useState('');
  const [promoTargetId, setPromoTargetId] = useState('');

  // نموذج منح العملات
  const [grantUserId, setGrantUserId] = useState('');
  const [grantAmount, setGrantAmount] = useState(100);
  const [grantReason, setGrantReason] = useState('منح تجريبي عبر لوحة الإدارة');

  const mounted = useRef(true);
  const grantKeyRef = useRef<string | null>(null);
  const grantFpRef = useRef<string | null>(null);
  const subKeyRef = useRef<string | null>(null);
  const subFpRef = useRef<string | null>(null);
  const renewKeyRef = useRef<Record<string,string>>({});
  const renewFpRef = useRef<Record<string,string>>({});
  const promoKeyRef = useRef<string | null>(null);
  const promoFpRef = useRef<string | null>(null);
  const [grantInFlight, setGrantInFlight] = useState(false);
  const [subInFlight, setSubInFlight] = useState(false);
  const [promoInFlight, setPromoInFlight] = useState(false);
  const [renewInFlight, setRenewInFlight] = useState<Record<string,boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: ok, error } = await isSandboxFounder();
        if (!cancelled) {
          if (error) {
            toast.error(`تعذر التحقق من صلاحية المؤسس: ${(error as Error).message}`);
            setFounder(false);
          } else {
            setFounder(Boolean(ok));
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const [l, t, r, s, p, a] = await Promise.all([
      fetchSandboxLedger({ userId: '', page: 0, pageSize: 200, all: true }),
      fetchSandboxTopUps({ userId: '', page: 0, pageSize: 200, all: true }),
      fetchSandboxRefunds({ userId: '', all: true }),
      fetchSandboxSubscriptions({ userId: '', all: true }),
      fetchSandboxPromotions({ userId: '', all: true }),
      fetchSandboxAdminActions({ page: 0, pageSize: 200, all: true }),
    ]);
    const show = (label: string, res: { error: Error | null }) => {
      if (res.error) toast.error(`${label}: ${(res.error as Error).message}`);
    };
    show('السجل المالي', l);
    show('عمليات الشحن', t);
    show('الاستردادات', r);
    show('الاشتراكات', s);
    show('الحملات الترويجية', p);
    show('إجراءات المسؤول', a);

    if (mounted.current) {
      setLedger(l.data ?? []);
      setTopUps(t.data ?? []);
      setRefunds(r.data ?? []);
      setSubs(s.data ?? []);
      setPromos(p.data ?? []);
      setAdminActions(a.data ?? []);
    }
  }, []);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (founder === true) {
      void Promise.all([
        fetchSandboxTopUpPackages().then((res) => {
          if (res.error) toast.error(`حزم الشحن: ${(res.error as Error).message}`);
          else setTopUpPackages(res.data ?? []);
        }),
        fetchSandboxSubscriptionPackages().then((res) => {
          if (res.error) toast.error(`حزم الاشتراك: ${(res.error as Error).message}`);
          else setSubPackages(res.data ?? []);
        }),
        fetchSandboxPromotionPackages().then((res) => {
          if (res.error) toast.error(`حزم الترويج: ${(res.error as Error).message}`);
          else setPromoPackages(res.data ?? []);
        }),
      ]);
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [founder]);

  if (loading) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle>جاري التحقق من صلاحية المؤسس...</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2">
          <span className="animate-spin rounded-full border-2 border-current h-5 w-5" />
        </CardContent>
      </Card>
    );
  }

  if (founder !== true) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle>لوحة إدارة Sandbox التجريبية</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>
              غير مصرح لك بالدخول إلى لوحة إدارة Sandbox. هوية المؤسس تُثبت من جلسة موثقة وصلاحية خادم فقط.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const handleGrant = async () => {
    if (grantInFlight) return;
    const fp = `${grantUserId}|${grantAmount}|${grantReason}`;
    if (grantFpRef.current !== fp) {
      grantFpRef.current = fp;
      grantKeyRef.current = generateIdempotencyKey('sandbox-grant');
    }
    if (!grantKeyRef.current) grantKeyRef.current = generateIdempotencyKey('sandbox-grant');
    setGrantInFlight(true);
    try {
      const res = await grantSandboxCoins({ userId: grantUserId, amount: grantAmount, reason: grantReason, idempotencyKey: grantKeyRef.current });
      if (res.ok) {
        toast.success(`تم منح ${res.amount} عملة تجريبية`);
        grantKeyRef.current = null;
        grantFpRef.current = null;
        setGrantUserId('');
        setGrantAmount(100);
        setGrantReason('منح تجريبي عبر لوحة الإدارة');
        void refresh();
      } else {
        toast.error(res.error ? (res.error as Error).message : 'فشل المنح');
      }
    } finally {
      setGrantInFlight(false);
    }
  };

  const handleRefund = async (topUpId: string, reason: string) => {
    const res = await refundSandboxTopUp({ topUpId, reason });
    if (res.ok) {
      toast.success('تم الاسترداد التجريبي');
      void refresh();
    } else {
      toast.error(res.error ? (res.error as Error).message : 'فشل الاسترداد');
    }
  };

  const handleActivateSub = async (packageId: string): Promise<void> => {
    if (!subUserId) {
      toast.error('معرف المستخدم مطلوب لتفعيل الاشتراك');
      return;
    }
    if (subInFlight) return;
    const fp = `${subUserId}|${packageId}`;
    if (subFpRef.current !== fp) {
      subFpRef.current = fp;
      subKeyRef.current = generateIdempotencyKey('sandbox-sub');
    }
    if (!subKeyRef.current) subKeyRef.current = generateIdempotencyKey('sandbox-sub');
    setSubInFlight(true);
    try {
      const res = await activateSandboxSubscription({ userId: subUserId, packageId, idempotencyKey: subKeyRef.current });
      if (res.ok) {
        subKeyRef.current = null;
        subFpRef.current = null;
        toast.success('تم تفعيل الاشتراك التجريبي');
        void refresh();
      } else {
        toast.error(res.error ? (res.error as Error).message : 'فشل التفعيل');
      }
    } finally {
      setSubInFlight(false);
    }
  };

  const handleCancelSub = async (subscriptionId: string) => {
    const res = await cancelSandboxSubscription({ subscriptionId });
    if (res.ok) {
      toast.success('تم إلغاء الاشتراك التجريبي');
      void refresh();
    } else {
      toast.error(res.error ? (res.error as Error).message : 'فشل الإلغاء');
    }
  };

  const handleRenewSub = async (subscriptionId: string) => {
    if (renewInFlight[subscriptionId]) return;
    if (!renewKeyRef.current[subscriptionId]) renewKeyRef.current[subscriptionId] = generateIdempotencyKey('sandbox-renew');
    setRenewInFlight(prev => ({ ...prev, [subscriptionId]: true }));
    try {
      const res = await renewSandboxSubscription({ subscriptionId, idempotencyKey: renewKeyRef.current[subscriptionId] });
      if (res.ok) {
        delete renewKeyRef.current[subscriptionId];
        delete renewFpRef.current[subscriptionId];
        toast.success('تم تجديد الاشتراك التجريبي');
        void refresh();
      } else {
        toast.error(res.error ? (res.error as Error).message : 'فشل التجديد');
      }
    } finally {
      setRenewInFlight(prev => ({ ...prev, [subscriptionId]: false }));
    }
  };

  const handleCreatePromo = async (packageId: string, targetType: 'post' | 'reel'): Promise<void> => {
    if (!promoUserId) {
      toast.error('معرف المستخدم مطلوب لإنشاء الحملة');
      return;
    }
    if (!promoTargetId) {
      toast.error('معرف الهدف (المنشور/الريل) مطلوب لإنشاء الحملة');
      return;
    }
    if (promoInFlight) return;
    const fp = `${promoUserId}|${promoTargetId}|${packageId}|${targetType}`;
    if (promoFpRef.current !== fp) {
      promoFpRef.current = fp;
      promoKeyRef.current = generateIdempotencyKey('sandbox-promo');
    }
    if (!promoKeyRef.current) promoKeyRef.current = generateIdempotencyKey('sandbox-promo');
    setPromoInFlight(true);
    try {
      const res = await createSandboxPromotion({ userId: promoUserId, packageId, targetType, targetId: promoTargetId, idempotencyKey: promoKeyRef.current });
      if (res.ok) {
        promoKeyRef.current = null;
        promoFpRef.current = null;
        toast.success('تم إنشاء الحملة الترويجية التجريبية');
        void refresh();
      } else {
        toast.error(res.error ? (res.error as Error).message : 'فشل إنشاء الحملة');
      }
    } finally {
      setPromoInFlight(false);
    }
  };

  const handleEndPromo = async (promotionId: string, success: boolean, reason?: string) => {
    const res = await endSandboxPromotion({ promotionId, success, failureReason: reason });
    if (res.ok) {
      toast.success(`انتهت الحملة: ${res.status}`);
      void refresh();
    } else {
      toast.error(res.error ? (res.error as Error).message : 'فشل إنهاء الحملة');
    }
  };

  const statusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive'> = {
      active: 'default', completed: 'default', ended: 'secondary', failed: 'destructive',
      cancelled: 'destructive', refunded: 'secondary', pending: 'default',
    };
    return <Badge variant={variants[status] ?? 'default'}>{status}</Badge>;
  };

  const totalsCredit = ledger.filter((e) => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
  const totalsDebit = ledger.filter((e) => e.type === 'debit').reduce((s, e) => s + e.amount, 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>لوحة إدارة Sandbox التجريبية</CardTitle>
          <p className="text-sm text-muted-foreground">
            بيئة تجريبية معزولة تمامًا عن الإنتاج؛ لا بوابة دفع حقيقية، ولا أرصدة أو شعبية حقيقية.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full grid w-full grid-cols-1 sm:grid-cols-4 gap-1">
              <TabsTrigger value="grants" className="text-sm">منح عملات تجريبية</TabsTrigger>
              <TabsTrigger value="topups" className="text-sm">مراجعة الشحن والاسترداد</TabsTrigger>
              <TabsTrigger value="subs" className="text-sm">الاشتراكات</TabsTrigger>
              <TabsTrigger value="promos" className="text-sm">الترويج</TabsTrigger>
              <TabsTrigger value="logs" className="text-sm">السجلات والتدقيق</TabsTrigger>
            </TabsList>

            <TabsContent value="grants" className="space-y-3 mt-3">
              <div className="grid sm:grid-cols-4 gap-3 items-end">
                <div className="flex flex-col gap-1">
                  <Label>معرف المستخدم</Label>
                  <Input
                    value={grantUserId}
                    onChange={(e) => setGrantUserId(e.target.value)}
                    placeholder="user-uuid"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>المبلغ</Label>
                  <Input
                    value={String(grantAmount)}
                    onChange={(e) => setGrantAmount(Number(e.target.value) || 0)}
                    type="number"
                    placeholder="100"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>السبب</Label>
                  <Input
                    value={grantReason}
                    onChange={(e) => setGrantReason(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Button onClick={handleGrant}>منح</Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="topups" className="space-y-3 mt-3">
              <h4 className="text-sm font-medium">عمليات الشحن التجريبية</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableCell>المستخدم</TableCell>
                    <TableCell>الباقة</TableCell>
                    <TableCell>المبلغ</TableCell>
                    <TableCell>الحالة</TableCell>
                    <TableCell>تمت المحاكاة</TableCell>
                    <TableCell>وقت الإنشاء</TableCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topUps.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="text-xs">{t.user_id}</TableCell>
                      <TableCell className="text-xs">{t.package_id}</TableCell>
                      <TableCell className="text-xs">{t.amount}</TableCell>
                      <TableCell className="text-xs">{statusBadge(t.status)}</TableCell>
                      <TableCell className="text-xs">{t.simulated ? 'نعم' : 'لا'}</TableCell>
                      <TableCell className="text-xs">{t.created_at}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex gap-2 mt-3">
                {topUps.filter((t) => t.status === 'completed').map((t) => (
                  <Button
                    key={t.id}
                    size="sm"
                    variant="outline"
                    onClick={() => handleRefund(t.id, 'استرداد تجريبي من لوحة الإدارة')}
                  >
                    استرداد
                  </Button>
                ))}
              </div>
              <Separator className="my-4" />
              <h4 className="text-sm font-medium">حزم الشحن المتاحة (للمستخدمين)</h4>
              <div className="grid sm:grid-cols-4 gap-3">
                {topUpPackages.map((pkg) => (
                  <Card key={pkg.id} className="p-3">
                    <CardContent className="space-y-2">
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="font-medium">{pkg.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {pkg.coins} عملة
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="subs" className="space-y-3 mt-3">
              <div className="grid sm:grid-cols-4 gap-3 items-end">
                <div className="flex flex-col gap-1">
                  <Label>معرف المستخدم للتفعيل</Label>
                  <Input
                    value={subUserId}
                    onChange={(e) => setSubUserId(e.target.value)}
                    placeholder="user-uuid"
                  />
                </div>
                {subPackages.map((pkg) => (
                  <Card key={pkg.id} className="p-3">
                    <CardContent className="space-y-2">
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="font-medium">{pkg.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {pkg.coins_price} عملة × {pkg.duration_days} يوم
                          </div>
                        </div>
                        <Button size="sm" onClick={() => handleActivateSub(pkg.id)}>
                          تفعيل
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <Separator className="my-4" />
              <h4 className="text-sm font-medium">اشتراكات المستخدمين التجريبية</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableCell>المستخدم</TableCell>
                    <TableCell>الحزمة</TableCell>
                    <TableCell>الحالة</TableCell>
                    <TableCell>العملات المدفوعة</TableCell>
                    <TableCell>انتهاء</TableCell>
                    <TableCell>إجراء</TableCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subs.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs">{s.user_id}</TableCell>
                      <TableCell className="text-xs">{s.package_id}</TableCell>
                      <TableCell className="text-xs">{statusBadge(s.status)}</TableCell>
                      <TableCell className="text-xs">{s.coins_charged}</TableCell>
                      <TableCell className="text-xs">{s.ended_at ?? '—'}</TableCell>
                      <TableCell className="text-xs">
                        {s.status === 'active' ? (
                          <>
                            <Button size="sm" onClick={() => handleCancelSub(s.id)}>
                              إلغاء
                            </Button>{' '}
                            <Button size="sm" onClick={() => handleRenewSub(s.id)}>
                              تجديد
                            </Button>
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="promos" className="space-y-3 mt-3">
              <div className="grid sm:grid-cols-4 gap-3 items-end">
                <div className="flex flex-col gap-1">
                  <Label>معرف المستخدم</Label>
                  <Input
                    value={promoUserId}
                    onChange={(e) => setPromoUserId(e.target.value)}
                    placeholder="user-uuid"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>معرف الهدف (منشور/ريل)</Label>
                  <Input
                    value={promoTargetId}
                    onChange={(e) => setPromoTargetId(e.target.value)}
                    placeholder="target-uuid"
                  />
                </div>
                {promoPackages.map((pkg) => (
                  <Card key={pkg.id} className="p-3">
                    <CardContent className="space-y-2">
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="font-medium">{pkg.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {pkg.coins_price} عملة × {pkg.duration_days} يوم
                          </div>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => handleCreatePromo(pkg.id, pkg.target_type as 'post' | 'reel')}
                        >
                          إنشاء حملة
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <Separator className="my-4" />
              <h4 className="text-sm font-medium">حملات الترويج التجريبية</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableCell>المستخدم</TableCell>
                    <TableCell>النوع / الهدف</TableCell>
                    <TableCell>الحالة</TableCell>
                    <TableCell>العملات المخصومة</TableCell>
                    <TableCell>انتهاء</TableCell>
                    <TableCell>إجراء</TableCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {promos.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-xs">{p.user_id}</TableCell>
                      <TableCell className="text-xs">{p.target_type}: {p.target_id}</TableCell>
                      <TableCell className="text-xs">{statusBadge(p.status)}</TableCell>
                      <TableCell className="text-xs">{p.coins_deducted}</TableCell>
                      <TableCell className="text-xs">{p.ends_at ?? '—'}</TableCell>
                      <TableCell className="text-xs">
                        {p.status === 'active' ? (
                          <>
                            <Button size="sm" onClick={() => handleEndPromo(p.id, true)}>
                              إنهاء
                            </Button>{' '}
                            <Button size="sm" variant="destructive" onClick={() => handleEndPromo(p.id, false, 'فشل تجريبي')}>
                              فشل
                            </Button>
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="logs" className="space-y-3 mt-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <Card>
                  <CardHeader>
                    <CardTitle>السجل المالي (Ledger)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableCell>النوع</TableCell>
                          <TableCell>المبلغ</TableCell>
                          <TableCell>المرجع</TableCell>
                          <TableCell>الوقت</TableCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ledger.map((e) => (
                          <TableRow key={e.id}>
                            <TableCell className="text-xs">{e.type}</TableCell>
                            <TableCell className="text-xs">{e.type === 'credit' ? '+' : '−'}{e.amount}</TableCell>
                            <TableCell className="text-xs">{e.reference}</TableCell>
                            <TableCell className="text-xs">{e.created_at}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>إجراءات المسؤول (تدقيق)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableCell>الفاعل</TableCell>
                          <TableCell>الإجراء</TableCell>
                          <TableCell>النتيجة</TableCell>
                          <TableCell>الوقت</TableCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {adminActions.map((a) => (
                          <TableRow key={a.id}>
                            <TableCell className="text-xs">{a.actor_user_id}</TableCell>
                            <TableCell className="text-xs">{a.action}</TableCell>
                            <TableCell className="text-xs">{statusBadge(a.result)}</TableCell>
                            <TableCell className="text-xs">{a.created_at}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </div>
              <Card className="mt-3">
                <CardHeader>
                  <CardTitle>الاستردادات التجريبية</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableCell>عملية الشحن</TableCell>
                        <TableCell>المستخدم</TableCell>
                        <TableCell>المبلغ</TableCell>
                        <TableCell>السبب</TableCell>
                        <TableCell>الوقت</TableCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {refunds.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="text-xs">{r.top_up_id}</TableCell>
                          <TableCell className="text-xs">{r.user_id}</TableCell>
                          <TableCell className="text-xs">{r.amount}</TableCell>
                          <TableCell className="text-xs">{r.reason}</TableCell>
                          <TableCell className="text-xs">{r.created_at}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Separator className="my-3" />
              <div className="grid sm:grid-cols-3 gap-4">
                <Card className="p-4">
                  <CardContent className="flex flex-col items-center text-center">
                    <div className="text-xs text-muted-foreground">إجمالي الأرصدة المضافة</div>
                    <div className="font-mono text-lg font-bold">{totalsCredit}</div>
                  </CardContent>
                </Card>
                <Card className="p-4">
                  <CardContent className="flex flex-col items-center text-center">
                    <div className="text-xs text-muted-foreground">إجمالي الأرصدة المسحوبة</div>
                    <div className="font-mono text-lg font-bold">{totalsDebit}</div>
                  </CardContent>
                </Card>
                <Card className="p-4">
                  <CardContent className="flex flex-col items-center text-center">
                    <div className="text-xs text-muted-foreground">صافي الرصيد المسجَّل</div>
                    <div className="font-mono text-lg font-bold">{totalsCredit - totalsDebit}</div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
