type NotificationRecord = {
  id?: unknown;
  user_id?: unknown;
  actor_id?: unknown;
  type?: unknown;
  content?: unknown;
  reference_id?: unknown;
  entity_id?: unknown;
  comment_id?: unknown;
  post_id?: unknown;
};

type ServiceAccount = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

type ProfilePushSettings = {
  fcm_token?: string | null;
  notification_settings?: Record<string, unknown> | null;
};

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

const jsonResponse = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

const asText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const truncateUtf8 = (value: string, maxBytes: number): string => {
  let result = '';
  let byteLength = 0;
  for (const character of value) {
    const characterLength = new TextEncoder().encode(character).length;
    if (byteLength + characterLength > maxBytes) return `${result}…`;
    result += character;
    byteLength += characterLength;
  }
  return result;
};

const encodeBase64Url = (value: string | Uint8Array) => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const constantTimeEquals = (left: string, right: string) => {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

async function getGoogleAccessToken(account: ServiceAccount): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.token;
  if (!account.client_email || !account.private_key || !account.token_uri) {
    throw new Error('FCM service account is missing required fields.');
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = encodeBase64Url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: account.token_uri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsignedAssertion = `${header}.${claims}`;
  const privateKeyPem = account.private_key.replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const privateKeyBytes = Uint8Array.from(atob(privateKeyPem), character => character.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsignedAssertion),
  );
  const assertion = `${unsignedAssertion}.${encodeBase64Url(new Uint8Array(signature))}`;
  const tokenResponse = await fetch(account.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const tokenBody = await tokenResponse.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
  if (!tokenResponse.ok || !tokenBody.access_token) throw new Error('Google OAuth token exchange failed.');

  cachedAccessToken = {
    token: tokenBody.access_token,
    expiresAt: Date.now() + (Number(tokenBody.expires_in) || 3600) * 1000,
  };
  return tokenBody.access_token;
}

async function getPostIdForComment(
  supabaseUrl: string,
  serviceRoleKey: string,
  commentId: string,
): Promise<string> {
  const url = new URL('/rest/v1/comments', supabaseUrl);
  url.searchParams.set('select', 'post_id');
  url.searchParams.set('id', `eq.${commentId}`);
  url.searchParams.set('limit', '1');
  const response = await fetch(url, {
    headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) return '';
  const rows = await response.json().catch(() => []) as Array<{ post_id?: unknown }>;
  return asText(rows[0]?.post_id);
}

function notificationUrl(record: NotificationRecord, postIdForComment = ''): string {
  const type = asText(record.type).toLowerCase();
  const actorId = asText(record.actor_id);
  const referenceId = asText(record.reference_id) || asText(record.entity_id);
  const commentId = asText(record.comment_id);
  const postId = asText(record.post_id) || postIdForComment || referenceId;
  const encode = encodeURIComponent;

  const isStoryNotification = ['story', 'story_like'].includes(type)
    || (['like', 'reply', 'mention'].includes(type) && /ستوري|قصة/i.test(asText(record.content)));
  if (isStoryNotification && referenceId) {
    const storyOwnerId = ['story', 'mention'].includes(type) ? actorId || asText(record.user_id) : asText(record.user_id);
    const query = new URLSearchParams({ openStoryId: referenceId, openStoryOwner: storyOwnerId });
    return `/feed?${query.toString()}`;
  }

  if (type === 'follow_request') return '/feed?openFollowRequests=1';
  if (['follow', 'followed', 'new_follower'].includes(type) && actorId) return `/profile/${encode(actorId)}`;
  if (['message', 'new_message'].includes(type) && actorId) return `/messages/${encode(actorId)}`;
  if (['call', 'incoming_call'].includes(type) && actorId) {
    const query = new URLSearchParams({ openCall: '1', callerId: actorId });
    if (referenceId) query.set('callId', referenceId);
    return `/messages/${encode(actorId)}?${query.toString()}`;
  }
  if (['comment', 'reply'].includes(type) && postId) {
    const query = new URLSearchParams({ showComments: '1' });
    if (commentId) query.set('commentId', commentId);
    return `/post/${encode(postId)}?${query.toString()}`;
  }
  if (['like', 'repost'].includes(type) && postId) return `/post/${encode(postId)}`;
  return '/feed';
}

function notificationTitle(type: string): string {
  if (type === 'like') return 'إعجاب جديد';
  if (type === 'comment' || type === 'reply') return 'تعليق جديد';
  if (['follow', 'followed', 'new_follower'].includes(type)) return 'متابع جديد';
  if (type === 'follow_request') return 'طلب متابعة جديد';
  if (type === 'message' || type === 'new_message') return 'رسالة جديدة';
  if (type === 'call' || type === 'incoming_call') return 'مكالمة واردة';
  if (type.startsWith('story')) return 'إشعار قصة جديد';
  return 'إشعار جديد من آني';
}

function preferenceCategory(type: string): string {
  if (['message', 'new_message', 'call', 'incoming_call'].includes(type)) return 'messages';
  if (['follow', 'followed', 'new_follower', 'follow_request'].includes(type)) return 'followers';
  if (type.startsWith('story')) return 'stories';
  return 'interactions';
}

Deno.serve(async request => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('PUSH_WEBHOOK_SECRET') || '';
  if (!expectedSecret || !constantTimeEquals(request.headers.get('x-push-webhook-secret') || '', expectedSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const serviceAccountJson = Deno.env.get('FIREBASE_SERVICE_ACCOUNT')
    || Deno.env.get('FCM_SERVICE_ACCOUNT_JSON')
    || '';
  if (!supabaseUrl || !serviceRoleKey || !serviceAccountJson) {
    console.error('[push] Missing Supabase or Firebase function secrets.');
    return jsonResponse({ error: 'Push notification service is not configured.' }, 500);
  }

  let payload: { type?: unknown; table?: unknown; schema?: unknown; record?: NotificationRecord };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400);
  }
  if (payload.schema !== 'public' || payload.table !== 'notifications' || payload.type !== 'INSERT' || !payload.record) {
    return jsonResponse({ skipped: true, reason: 'Not a notification insert.' });
  }

  const record = payload.record;
  const userId = asText(record.user_id);
  const type = asText(record.type).toLowerCase();
  if (!userId || !type) return jsonResponse({ skipped: true, reason: 'Notification is missing its recipient or type.' });

  const profileUrl = new URL('/rest/v1/profiles', supabaseUrl);
  profileUrl.searchParams.set('select', 'fcm_token,notification_settings');
  profileUrl.searchParams.set('id', `eq.${userId}`);
  profileUrl.searchParams.set('limit', '1');
  const profileResponse = await fetch(profileUrl, {
    headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!profileResponse.ok) {
    console.error('[push] Could not load the recipient profile.');
    return jsonResponse({ error: 'Could not load recipient profile.' }, 502);
  }
  const profiles = await profileResponse.json().catch(() => []) as ProfilePushSettings[];
  const profile = profiles[0];
  const token = asText(profile?.fcm_token);
  if (!token) return jsonResponse({ skipped: true, reason: 'Recipient has no registered device token.' });
  if (profile?.notification_settings?.[preferenceCategory(type)] === false) {
    return jsonResponse({ skipped: true, reason: 'Recipient disabled this notification category.' });
  }

  let account: ServiceAccount;
  try {
    account = JSON.parse(serviceAccountJson) as ServiceAccount;
  } catch {
    console.error('[push] Firebase service account secret is not valid JSON.');
    return jsonResponse({ error: 'Firebase service account configuration is invalid.' }, 500);
  }
  if (!account.project_id) return jsonResponse({ error: 'Firebase service account is missing its project id.' }, 500);

  const commentId = asText(record.comment_id);
  const postIdForComment = commentId && (type === 'comment' || type === 'reply' || type === 'like')
    ? await getPostIdForComment(supabaseUrl, serviceRoleKey, commentId)
    : '';
  const accessToken = await getGoogleAccessToken(account);
  const fcmResponse = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        data: {
          title: notificationTitle(type),
          body: truncateUtf8(asText(record.content) || notificationTitle(type), 1500),
          url: notificationUrl(record, postIdForComment),
          notification_id: asText(record.id),
          type,
          actor_id: asText(record.actor_id),
          post_id: asText(record.post_id) || postIdForComment || (type === 'like' ? asText(record.reference_id) || asText(record.entity_id) : ''),
          comment_id: commentId,
          call_id: ['call', 'incoming_call'].includes(type) ? asText(record.reference_id) : '',
        },
        webpush: { headers: { Urgency: 'high' } },
      },
    }),
  });

  if (!fcmResponse.ok) {
    const errorBody = await fcmResponse.text().catch(() => '');
    console.error('[push] FCM send failed:', fcmResponse.status, errorBody.slice(0, 1000));
    return jsonResponse({ error: 'Firebase rejected the push notification.' }, 502);
  }

  return jsonResponse({ sent: true });
});
