import { createSign } from "node:crypto";
import { logger } from "./logger";

// إرسال إشعارات FCM عبر HTTP v1 بدون أي اعتماد خارجي:
// توقيع JWT (RS256) بمفتاح حساب الخدمة ثم استبداله برمز وصول من Google.

export type FcmServiceAccount = {
  project_id?: unknown;
  client_email?: unknown;
  private_key?: unknown;
  token_uri?: unknown;
};

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

const base64UrlEncode = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64url");

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function readServiceAccount(): FcmServiceAccount | null {
  const raw =
    process.env["FIREBASE_SERVICE_ACCOUNT"] || process.env["FCM_SERVICE_ACCOUNT_JSON"] || "";
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as FcmServiceAccount;
    if (!asText(parsed.project_id)) return null;
    return parsed;
  } catch (error) {
    logger.error({ err: error }, "FIREBASE_SERVICE_ACCOUNT secret is not valid JSON");
    return null;
  }
}

async function getAccessToken(account: FcmServiceAccount): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  const clientEmail = asText(account.client_email);
  const tokenUri = asText(account.token_uri) || "https://oauth2.googleapis.com/token";
  const privateKey = asText(account.private_key).replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) {
    throw new Error("FCM service account is missing required fields.");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const unsignedAssertion = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(unsignedAssertion).sign(privateKey);

  const assertion = `${unsignedAssertion}.${base64UrlEncode(signature)}`;
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (!response.ok || !asText(body.access_token)) {
    throw new Error("Google OAuth token exchange failed.");
  }

  cachedAccessToken = {
    token: asText(body.access_token),
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
  return cachedAccessToken.token;
}

export type FcmSendResult = {
  ok: boolean;
  status: number;
  errorBody: string;
};

export async function sendFcmMessage(
  account: FcmServiceAccount,
  deviceToken: string,
  messagePayload: Record<string, unknown>,
): Promise<FcmSendResult> {
  const accessToken = await getAccessToken(account);
  const projectId = asText(account.project_id);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: { token: deviceToken, ...messagePayload },
      }),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    return { ok: false, status: response.status, errorBody: errorBody.slice(0, 1000) };
  }

  return { ok: true, status: response.status, errorBody: "" };
}
