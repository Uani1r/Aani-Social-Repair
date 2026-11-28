import type { CSSProperties } from 'react';

/**
 * صفحات الشروط وسياسة الخصوصية — النص نفسه المعروض داخل «إعدادات الحساب ←
 * سياسة الخصوصية وشروط الخدمة»، لكن على مسارين عامين يمكن الوصول إليهما قبل
 * إكمال التسجيل وبلا جلسة.
 *
 * كانت الموافقة في التسجيل بلا رابط فعلي؛ الآن الرابط يفتح صفحة موجودة:
 * /terms و/privacy. صفحة التطبيق تخدم هذه المسارات قبل بوابة الجلسة، وتوجيه
 * SPA في الخادم يخدم index.html لها.
 */

export type LegalDocumentKind = 'terms' | 'privacy';

export const LEGAL_DOCUMENTS: Record<LegalDocumentKind, { title: string; paragraphs: string[] }> = {
  privacy: {
    title: 'سياسة الخصوصية',
    paragraphs: [
      'يستخدم التطبيق بيانات الحساب والملف الشخصي والمحتوى الذي تنشئه لتقديم ميزات آني الاجتماعية، مثل المنشورات والرسائل والإشعارات. تُحفظ بيانات التطبيق المرتبطة بالحساب في خدماته السحابية، بينما قد تبقى بعض تفضيلات الاستخدام على جهازك.',
      'لا تشارك كلمة مرورك مع الآخرين، وتجنّب نشر معلومات شخصية لا ترغب في إتاحتها. استخدم أدوات الخصوصية والإبلاغ داخل التطبيق عند الحاجة.',
    ],
  },
  terms: {
    title: 'شروط الخدمة',
    paragraphs: [
      'باستخدام آني، توافق على احترام حقوق الآخرين وعدم نشر محتوى غير قانوني أو مضلل أو مسيء، وعدم محاولة تعطيل الخدمة أو الوصول غير المصرح به إلى الحسابات والبيانات.',
      'أنت مسؤول عن المحتوى الذي تنشره وعن حماية بيانات الدخول إلى حسابك. قد تتغير الميزات أو تتوقف مؤقتاً لأعمال الصيانة أو لأسباب أمنية.',
    ],
  },
};

export const LEGAL_NOTE =
  'هذه معلومات عامة داخل التطبيق وليست استشارة قانونية. راجع الشروط المحدثة عند نشرها رسمياً.';

/** يقرأ نوع المستند من المسار: /terms أو /privacy، وإلا null. */
export function readLegalDocumentFromPath(pathname: string | null | undefined): LegalDocumentKind | null {
  const path = (pathname || '').split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase() || '/';
  if (path === '/terms') return 'terms';
  if (path === '/privacy') return 'privacy';
  return null;
}

export function LegalPage({ kind, onBack }: { kind: LegalDocumentKind; onBack: () => void }) {
  const document = LEGAL_DOCUMENTS[kind];

  return (
    <div dir="rtl" style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>{document.title}</h1>
        {document.paragraphs.map((paragraph, index) => (
          <p key={index} style={styles.paragraph}>{paragraph}</p>
        ))}
        <p style={styles.note}>{LEGAL_NOTE}</p>
        <button type="button" onClick={onBack} style={styles.backButton}>
          العودة
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: '100dvh',
    width: '100%',
    backgroundColor: '#1a2b27',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '32px 16px 48px',
    boxSizing: 'border-box',
    fontFamily: "'Tajawal', sans-serif",
  },
  card: {
    width: '100%',
    maxWidth: '640px',
    backgroundColor: '#f5f6f4',
    borderRadius: '18px',
    padding: '24px',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.25)',
  },
  title: {
    margin: '0 0 16px',
    fontSize: '22px',
    fontWeight: 800,
    color: '#243b35',
  },
  paragraph: {
    margin: '0 0 14px',
    fontSize: '15px',
    lineHeight: 2,
    color: '#243b35',
  },
  note: {
    margin: '18px 0 20px',
    fontSize: '13px',
    lineHeight: 1.8,
    color: '#65716c',
  },
  backButton: {
    width: '100%',
    padding: '14px 16px',
    borderRadius: '12px',
    border: 'none',
    backgroundColor: '#243b35',
    color: '#ffffff',
    fontSize: '15px',
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: "'Tajawal', sans-serif",
  },
};

export default LegalPage;
