// محمِّل mediabunny المعزول عن وحدات الإقلاع.
//
// الهدف: أسماء الحزم «mediabunny» و«@mediabunny/aac-encoder» يجب ألا تظهر
// إلا في هذه الوحدة، حتى لا يوقف vite:import-analysis تحويل وحدات الإقلاع
// الأساسية عند غياب الحزمة من node_modules (خطأ "Failed to resolve import"
// الذي كان يتحول إلى شاشة بيضاء).
//
// كيف يعمل:
// - الحزمة مثبتة → تُحمَّل هذه الوحدة وتُعاد الواجهة، والضغط يعمل كالمعتاد.
// - الحزمة غير مثبتة → يفشل تحويل هذه الوحدة وحدها فيُرفض import()
//   وتلتقط mediaCompressor.ts الرفض وتستخدم المسار الاحتياطي الآمن، بينما
//   يبقى إقلاع التطبيق وشاشته سليمين تماماً.
//
// لماذا لا نمرر اسم الحزمة عبر متغير مع /* @vite-ignore */؟ لأن المتصفح
// لا يحل أسماء الحزم المجردة (bare specifiers) بنفسه؛ سيُرفض الاستيراد
// دائماً في dev حتى بعد التثبيت فيتعطل الضغط بصمت. الوحدة المنفصلة تحقق
// الحماية نفسها من الفحص الساكن دون كسر الوظيفة.

export async function loadMediabunnyModule(): Promise<unknown> {
  return await import('mediabunny');
}

export async function loadAacEncoderModule(): Promise<{
  registerAacEncoder: () => void;
}> {
  return (await import('@mediabunny/aac-encoder')) as unknown as {
    registerAacEncoder: () => void;
  };
}
