// عامل إرسال notification_outbox إلى أجهزة المستلم عبر FCM HTTP v1.
//
// يُشغَّل بجدولة (Cron) أو يدوياً POST بترويسة x-push-worker-secret.
// يستخدم مفاتيح الخادم فقط: SUPABASE_URL وSUPABASE_SERVICE_ROLE_KEY
// وFIREBASE_SERVICE_ACCOUNT — لا أسرار في العميل ولا في السجلات.
//
// لا يُسجَّل أي رمز جهاز أو سر أو نص رسالة: السجلات تحمل معرّفات وأرقاماً فقط.

import {
  classifyFcmResult,
  createPushOutboxHandler,
  type DeliveryRow,
  type DeviceTokenRow,
  type OutboxTask,
  type PushOutboxDeps,
  type SendOutcome,
} from '../_shared/pushOutbox.ts';

const FORBIDDEN_FIREBASE_PROJECT = 'ani1-20bed';
const REQUEST_TIMEOUT_MS = 10_000;
const TASK_LIMIT = 10;

type ServiceAccount = {
  project_id?: unknown;
  client_email?: unknown;
  private_key?: unknown;
  token_uri?: unknown;
};

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const encodeBase64Url = (value: string | Uint8Array): string => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

function readServiceAccount(): ServiceAccount {
  const raw = Deno.env.get('FIREBASE_SERVICE_ACCOUNT') || Deno.env.get('FCM_SERVICE_ACCOUNT_JSON') || '';
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is missing');
  const parsed = JSON.parse(raw) as ServiceAccount;
  if (!asText(parsed.project_id) || !asText(parsed.client_email) || !asText(parsed.private_key)) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is incomplete');
  }
  if (asText(parsed.project_id) === FORBIDDEN_FIREBASE_PROJECT) {
    throw new Error('the legacy Firebase project is not allowed');
  }
  return parsed;
}

function firebaseProjectId(account: ServiceAccount): string {
  const projectId = asText(Deno.env.get('FIREBASE_PROJECT_ID')) || asText(account.project_id);
  if (!projectId || projectId === FORBIDDEN_FIREBASE_PROJECT) {
    throw new Error('a valid Firebase project id is required (Ani Social)');
  }
  return projectId;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function googleAccessToken(account: ServiceAccount): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.token;

  const clientEmail = asText(account.client_email);
  const tokenUri = asText(account.token_uri) || 'https://oauth2.googleapis.com/token';
  const privateKeyPem = asText(account.private_key)
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const privateKeyBytes = Uint8Array.from(atob(privateKeyPem), character => character.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = encodeBase64Url(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`;

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
  const token = asText(body.access_token);
  if (!response.ok || !token) throw new Error('Google OAuth token exchange failed');

  cachedAccessToken = {
    token,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
  return token;
}

async function sendFcmMessage(
  projectId: string,
  account: ServiceAccount,
  message: Record<string, unknown>,
): Promise<SendOutcome> {
  const accessToken = await googleAccessToken(account);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      },
    );
    const body = await response.text().catch(() => '');
    return classifyFcmResult(response.status, body);
  } catch {
    // لا يُسجَّل نص الخطأ الشبكي هنا (قد يحمل تفاصيل الاتصال).
    return { ok: false, status: 0, retryable: true, error: 'transport' };
  } finally {
    clearTimeout(timer);
  }
}

type SupabaseConfig = { url: string; serviceRoleKey: string };

function requireSupabaseConfig(): SupabaseConfig {
  const url = asText(Deno.env.get('SUPABASE_URL'));
  const serviceRoleKey = asText(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  if (!url || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

async function restRequest(
  config: SupabaseConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.url}/rest/v1${path}`, {
      method: init.method || 'GET',
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`supabase_request_failed:${response.status}`);
    if (response.status === 204) return null;
    return await response.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

function createSupabaseDeps(config: SupabaseConfig, send: PushOutboxDeps['send']): PushOutboxDeps {
  return {
    async claim(worker, limit): Promise<OutboxTask[]> {
      const rows = asArray(await restRequest(config, '/rpc/aani_claim_notification_outbox', {
        method: 'POST',
        body: { p_worker: worker, p_limit: limit },
      }));
      return rows.flatMap((row): OutboxTask[] => {
        const id = asText(row.id);
        const recipient = asText(row.recipient_user_id);
        if (!id || !recipient) return [];
        const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {};
        return [{
          id,
          recipient_user_id: recipient,
          event_type: asText(row.event_type),
          payload,
          attempts: Number(row.attempts) || 1,
        }];
      });
    },
    async ensureDeliveries(outboxId): Promise<DeliveryRow[]> {
      const rows = asArray(await restRequest(config, '/rpc/aani_ensure_notification_deliveries', {
        method: 'POST',
        body: { p_outbox_id: outboxId },
      }));
      return rows.flatMap((row): DeliveryRow[] => {
        const id = asText(row.id);
        const deviceTokenId = asText(row.device_token_id);
        if (!id || !deviceTokenId) return [];
        return [{ id, outbox_id: asText(row.outbox_id) || outboxId, device_token_id: deviceTokenId, status: asText(row.status) }];
      });
    },
    async listPendingDeliveries(outboxId): Promise<DeliveryRow[]> {
      const query = `/notification_outbox_deliveries?outbox_id=eq.${encodeURIComponent(outboxId)}&status=eq.pending&select=id,outbox_id,device_token_id,status`;
      return asArray(await restRequest(config, query)).flatMap((row): DeliveryRow[] => {
        const id = asText(row.id);
        const deviceTokenId = asText(row.device_token_id);
        if (!id || !deviceTokenId) return [];
        return [{ id, outbox_id: outboxId, device_token_id: deviceTokenId, status: asText(row.status) }];
      });
    },
    async loadDevices(deviceIds): Promise<DeviceTokenRow[]> {
      if (deviceIds.length === 0) return [];
      const list = deviceIds.map(id => `"${id}"`).join(',');
      const query = `/device_tokens?id=in.(${encodeURIComponent(list)})&revoked_at=is.null&select=id,token,platform,provider`;
      return asArray(await restRequest(config, query)).flatMap((row): DeviceTokenRow[] => {
        const id = asText(row.id);
        const token = asText(row.token);
        if (!id || !token) return [];
        return [{ id, token, platform: asText(row.platform), provider: asText(row.provider) }];
      });
    },
    send,
    async completeDelivery(completion): Promise<void> {
      await restRequest(config, '/rpc/aani_complete_notification_delivery', {
        method: 'POST',
        body: {
          p_delivery_id: completion.id,
          p_status: completion.status,
          p_error: completion.error ?? null,
          p_provider_message_id: completion.providerMessageId ?? null,
          p_revoke_token: completion.revokeToken === true,
        },
      });
    },
    async completeOutbox(completion): Promise<void> {
      await restRequest(config, '/rpc/aani_complete_notification_outbox', {
        method: 'POST',
        body: {
          p_id: completion.id,
          p_status: completion.status,
          p_worker: completion.worker,
          p_error: completion.error ?? null,
          p_provider_message_id: completion.providerMessageId ?? null,
          p_retry_delay_seconds: completion.retryDelaySeconds ?? 0,
        },
      });
    },
    log(entry) {
      // معرّفات وأرقام فقط — لا رموز ولا أسرار ولا محتوى.
      console.log(JSON.stringify({ level: 'info', ...entry }));
    },
  };
}

const account = readServiceAccount();
const projectId = firebaseProjectId(account);
const config = requireSupabaseConfig();
const secret = asText(Deno.env.get('PUSH_WORKER_SECRET'));
const worker = asText(Deno.env.get('PUSH_WORKER_NAME')) || 'push-outbox-edge';

const handler = createPushOutboxHandler(
  createSupabaseDeps(config, (device, message) => sendFcmMessage(projectId, account, message)),
  { secret, worker, limit: TASK_LIMIT },
);

Deno.serve(handler);
