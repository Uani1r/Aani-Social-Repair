import {
  isMissingOptionalModerationAction,
  isMissingOptionalModerationRelation,
  markOptionalModerationRelationUnavailable,
} from './comments/localModeration';

export interface AppErrorNotice {
  id: string;
  operation: string;
  userMessage: string;
  diagnostic: string;
}

type ErrorListener = (notices: AppErrorNotice[]) => void;
type QueryVerb = 'select' | 'insert' | 'upsert' | 'update' | 'delete';

const noticeListeners = new Set<ErrorListener>();
const reportedErrors = new WeakSet<object>();
const recentDiagnostics = new Map<string, number>();
const installedClients = new WeakSet<object>();
let notices: AppErrorNotice[] = [];
let noticeSequence = 0;

const entities: Record<string, string> = {
  posts: 'المنشورات',
  likes: 'الإعجاب',
  comments: 'التعليقات',
  comment_likes: 'إعجاب التعليق',
  comment_dislikes: 'تقييم التعليق',
  bookmarks: 'المنشورات المحفوظة',
  saved_posts: 'المنشورات المحفوظة',
  reposts: 'إعادة النشر',
  stories: 'القصص',
  story_likes: 'إعجاب القصة',
  profiles: 'الملف الشخصي',
  notifications: 'الإشعارات',
  messages: 'الرسائل',
  follows: 'المتابعة',
  follow_requests: 'طلبات المتابعة',
};

const actionNames: Record<QueryVerb, string> = {
  select: 'تحميل',
  insert: 'حفظ',
  upsert: 'حفظ',
  update: 'تعديل',
  delete: 'حذف',
};

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function getDiagnostic(error: unknown): string {
  if (isObject(error)) {
    const values = [
      typeof error.code === 'string' ? `code: ${error.code}` : '',
      typeof error.message === 'string' ? error.message : '',
      typeof error.details === 'string' ? `details: ${error.details}` : '',
      typeof error.hint === 'string' ? `hint: ${error.hint}` : '',
      typeof error.stack === 'string' ? `stack: ${error.stack}` : '',
    ].filter(Boolean);
    if (values.length) return values.join('\n');
  }
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) || String(error);
  } catch {
    return String(error);
  }
}

function emitNotices() {
  const snapshot = notices;
  noticeListeners.forEach(listener => listener(snapshot));
}

export function getAppErrorNotices(): AppErrorNotice[] {
  return notices;
}

export function dismissAppError(id: string): void {
  const next = notices.filter(notice => notice.id !== id);
  if (next.length === notices.length) return;
  notices = next;
  emitNotices();
}

export function subscribeAppErrors(listener: ErrorListener): () => void {
  noticeListeners.add(listener);
  listener(notices);
  return () => noticeListeners.delete(listener);
}

export function wasAppErrorReported(error: unknown): boolean {
  return isObject(error) && reportedErrors.has(error);
}

export function markAppErrorReported(error: unknown): void {
  if (isObject(error)) reportedErrors.add(error);
}

export function handleAppError(
  operation: string,
  error: unknown,
  userMessage = 'تعذر إتمام العملية. حاول مرة أخرى.',
): void {
  if (isObject(error) && reportedErrors.has(error)) return;

  const diagnostic = getDiagnostic(error);
  const signature = `${operation}\n${diagnostic}`;
  const now = Date.now();
  const previousTime = recentDiagnostics.get(signature);
  if (previousTime !== undefined && now - previousTime < 1500) {
    if (isObject(error)) reportedErrors.add(error);
    return;
  }
  recentDiagnostics.set(signature, now);
  for (const [key, timestamp] of recentDiagnostics) {
    if (now - timestamp > 10000) recentDiagnostics.delete(key);
  }
  if (isObject(error)) reportedErrors.add(error);

  console.error(`[Aani diagnostic] ${operation}:`, error);
  notices = [...notices, {
    id: `${now}-${++noticeSequence}`,
    operation,
    userMessage,
    diagnostic,
  }].slice(-4);
  emitNotices();
}

export async function safeExecute<T>(
  operation: string,
  execute: () => Promise<T>,
  userMessage = 'تعذر إتمام العملية. حاول مرة أخرى.',
): Promise<T> {
  try {
    const result = await execute();
    if (isObject(result) && result.error) {
      handleAppError(operation, result.error, userMessage);
    }
    return result;
  } catch (error) {
    handleAppError(operation, error, userMessage);
    throw error;
  }
}

function operationForTable(table: string, verb: QueryVerb): { operation: string; userMessage: string } {
  const entity = entities[table] || `بيانات ${table}`;
  const action = actionNames[verb];
  return {
    operation: `فشل ${action} ${entity}`,
    userMessage: `تعذر ${action} ${entity}. حاول مرة أخرى.`,
  };
}

function reportResponseError(
  operation: string,
  userMessage: string,
  response: unknown,
  table?: string,
): void {
  if (!isObject(response) || !response.error) return;
  if (table && isMissingOptionalModerationRelation(table, response.error)) {
    markOptionalModerationRelationUnavailable(table);
    return;
  }
  handleAppError(operation, response.error, userMessage);
}

function wrapQueryBuilder(builder: unknown, table: string, state: { verb: QueryVerb }): unknown {
  if (!isObject(builder)) return builder;

  let proxy: object;
  proxy = new Proxy(builder, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (property === 'then' && typeof member === 'function') {
        return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
          const { operation, userMessage } = operationForTable(table, state.verb);
          return Reflect.apply(member, target, [
            (result: unknown) => {
              reportResponseError(operation, userMessage, result, table);
              return onFulfilled ? onFulfilled(result) : result;
            },
            (reason: unknown) => {
              if (isMissingOptionalModerationRelation(table, reason)) {
                markOptionalModerationRelationUnavailable(table);
              } else {
                handleAppError(operation, reason, userMessage);
              }
              if (onRejected) return onRejected(reason);
              throw reason;
            },
          ]);
        };
      }

      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        if (property === 'insert' || property === 'upsert' || property === 'update' || property === 'delete') {
          state.verb = property;
        }
        try {
          const result = Reflect.apply(member, target, args);
          return result === target ? proxy : wrapQueryBuilder(result, table, state);
        } catch (error) {
          const { operation, userMessage } = operationForTable(table, state.verb);
          if (isMissingOptionalModerationRelation(table, error)) {
            markOptionalModerationRelationUnavailable(table);
          } else {
            handleAppError(operation, error, userMessage);
          }
          throw error;
        }
      };
    },
  });
  return proxy;
}

function wrapStorageApi(storageApi: unknown, bucket: string): unknown {
  if (!isObject(storageApi)) return storageApi;
  return new Proxy(storageApi, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const method = String(property);
        const operation = method === 'remove'
          ? 'فشل حذف الوسائط'
          : method === 'download' || method === 'list'
            ? 'فشل تحميل الوسائط'
            : method.toLowerCase().includes('upload')
              ? 'فشل رفع الوسائط'
              : `فشل تنفيذ عملية التخزين (${method})`;
        const userMessage = method === 'remove'
          ? 'تعذر حذف ملف الوسائط.'
          : method.toLowerCase().includes('upload')
            ? 'تعذر رفع ملف الوسائط. حاول مرة أخرى.'
            : 'تعذر الوصول إلى ملف الوسائط.';
        try {
          const result = Reflect.apply(member, target, args);
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            return (result as Promise<unknown>).then(
              value => {
                reportResponseError(`${operation} (${bucket})`, userMessage, value);
                return value;
              },
              error => {
                handleAppError(`${operation} (${bucket})`, error, userMessage);
                throw error;
              },
            );
          }
          reportResponseError(`${operation} (${bucket})`, userMessage, result);
          return result;
        } catch (error) {
          handleAppError(`${operation} (${bucket})`, error, userMessage);
          throw error;
        }
      };
    },
  });
}

export function installSupabaseErrorInterceptor(client: unknown): void {
  if (!isObject(client) || installedClients.has(client)) return;

  const target = client as unknown as {
    from: (table: string) => unknown;
    rpc: (...args: unknown[]) => unknown;
    storage: { from: (bucket: string) => unknown };
    functions: { invoke: (...args: unknown[]) => unknown };
    auth: Record<string, (...args: unknown[]) => unknown>;
  };

  try {
    const originalFrom = target.from.bind(client);
    target.from = (table: string) => {
      try {
        return wrapQueryBuilder(originalFrom(table), table, { verb: 'select' });
      } catch (error) {
        const { operation, userMessage } = operationForTable(table, 'select');
        if (isMissingOptionalModerationRelation(table, error)) {
          markOptionalModerationRelationUnavailable(table);
        } else {
          handleAppError(operation, error, userMessage);
        }
        throw error;
      }
    };

    const originalRpc = target.rpc.bind(client);
    target.rpc = (...args: unknown[]) => {
      const functionName = String(args[0] || 'database function');
      const operation = `فشل تنفيذ الإجراء ${functionName}`;
      const userMessage = 'تعذر إتمام إجراء قاعدة البيانات. حاول مرة أخرى.';
      const reportRpcError = (response: unknown) => {
        if (!isObject(response) || !response.error) return;
        if (isMissingOptionalModerationAction(functionName, response.error)) return;
        handleAppError(operation, response.error, userMessage);
      };
      try {
        const result = originalRpc(...args);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          return (result as Promise<unknown>).then(
            value => {
              reportRpcError(value);
              return value;
            },
            error => {
              if (!isMissingOptionalModerationAction(functionName, error)) {
                handleAppError(operation, error, userMessage);
              }
              throw error;
            },
          );
        }
        reportRpcError(result);
        return result;
      } catch (error) {
        if (!isMissingOptionalModerationAction(functionName, error)) {
          handleAppError(operation, error, userMessage);
        }
        throw error;
      }
    };

    const originalStorageFrom = target.storage.from.bind(target.storage);
    target.storage.from = (bucket: string) => wrapStorageApi(originalStorageFrom(bucket), bucket) as ReturnType<typeof target.storage.from>;

    const originalInvoke = target.functions.invoke.bind(target.functions);
    target.functions.invoke = (...args: unknown[]) => {
      const functionName = String(args[0] || 'edge function');
      const operation = `فشل تشغيل ${functionName}`;
      const userMessage = 'تعذر إتمام العملية عن طريق الخدمة. حاول مرة أخرى.';
      try {
        const result = originalInvoke(...args);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          return (result as Promise<unknown>).then(
            value => {
              reportResponseError(operation, userMessage, value);
              return value;
            },
            error => {
              handleAppError(operation, error, userMessage);
              throw error;
            },
          );
        }
        reportResponseError(operation, userMessage, result);
        return result;
      } catch (error) {
        handleAppError(operation, error, userMessage);
        throw error;
      }
    };

    try {
      const authOperations: Record<string, { operation: string; userMessage: string }> = {
        getUser: { operation: 'فشل التحقق من هوية المستخدم', userMessage: 'تعذر التحقق من هوية المستخدم.' },
        getSession: { operation: 'فشل استعادة جلسة المستخدم', userMessage: 'تعذر استعادة جلسة الحساب.' },
        signInWithPassword: { operation: 'فشل تسجيل الدخول', userMessage: 'تعذر تسجيل الدخول. تحقق من بيانات الحساب.' },
        signUp: { operation: 'فشل إنشاء الحساب', userMessage: 'تعذر إنشاء الحساب. حاول مرة أخرى.' },
        signOut: { operation: 'فشل تسجيل الخروج', userMessage: 'تعذر تسجيل الخروج بأمان.' },
        updateUser: { operation: 'فشل تحديث الحساب', userMessage: 'تعذر تحديث بيانات الحساب.' },
        resetPasswordForEmail: { operation: 'فشل إرسال رابط إعادة تعيين كلمة المرور', userMessage: 'تعذر إرسال رابط إعادة تعيين كلمة المرور.' },
        verifyOtp: { operation: 'فشل التحقق من رمز الحساب', userMessage: 'تعذر التحقق من رمز الحساب.' },
        refreshSession: { operation: 'فشل تحديث جلسة المستخدم', userMessage: 'تعذر تحديث جلسة الحساب.' },
        setSession: { operation: 'فشل استعادة جلسة المستخدم', userMessage: 'تعذر استعادة جلسة الحساب.' },
      };
      const authTarget = target.auth;
      target.auth = new Proxy(authTarget, {
        get(auth, property) {
          const member = Reflect.get(auth, property, auth);
          if (typeof member !== 'function') return member;

          return (...args: unknown[]) => {
            const method = String(property);
            const { operation, userMessage } = authOperations[method] || {
              operation: `فشل تنفيذ مصادقة Supabase (${method})`,
              userMessage: 'تعذر إتمام التحقق من الحساب. حاول مرة أخرى.',
            };
            try {
              const result = Reflect.apply(member, auth, args);
              if (result && typeof (result as { then?: unknown }).then === 'function') {
                return (result as Promise<unknown>).then(
                  value => {
                    reportResponseError(operation, userMessage, value);
                    return value;
                  },
                  error => {
                    handleAppError(operation, error, userMessage);
                    throw error;
                  },
                );
              }
              reportResponseError(operation, userMessage, result);
              return result;
            } catch (error) {
              handleAppError(operation, error, userMessage);
              throw error;
            }
          };
        },
      });
    } catch (error) {
      console.error('[Aani diagnostic] Failed to install Supabase auth interceptor:', error);
    }

    installedClients.add(client);
  } catch (error) {
    console.error('[Aani diagnostic] Failed to install Supabase interceptor:', error);
  }
}
