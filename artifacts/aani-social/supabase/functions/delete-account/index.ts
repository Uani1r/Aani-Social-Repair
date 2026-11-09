const STORAGE_BUCKET = "aani-media";
const STORAGE_PAGE_SIZE = 100;
const STORAGE_DELETE_BATCH_SIZE = 100;

type StorageEntry = {
  name: string;
  id?: string | null;
  metadata?: Record<string, unknown> | null;
};

function jsonResponse(body: Record<string, unknown>, status: number, origin: string | null): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin ?? "*",
      "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Vary": "Origin",
    },
  });
}

function storageHeaders(serviceRoleKey: string): HeadersInit {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function responseError(response: Response): Promise<string> {
  const body = await response.text();
  if (!body) return `Supabase request failed (${response.status}).`;
  try {
    const parsed = JSON.parse(body) as { message?: string; msg?: string; error?: string };
    return parsed.message ?? parsed.msg ?? parsed.error ?? `Supabase request failed (${response.status}).`;
  } catch {
    return `Supabase request failed (${response.status}).`;
  }
}

async function listOwnedStorageObjects(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<string[]> {
  const paths: string[] = [];
  const visitFolder = async (prefix: string, depth: number): Promise<void> => {
    if (depth > 12) throw new Error("Storage folder nesting is unexpectedly deep.");
    let offset = 0;
    while (true) {
      const response = await fetch(`${supabaseUrl}/storage/v1/object/list/${encodeURIComponent(STORAGE_BUCKET)}`, {
        method: "POST",
        headers: storageHeaders(serviceRoleKey),
        body: JSON.stringify({ prefix, limit: STORAGE_PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const entries = await response.json() as StorageEntry[];
      if (!Array.isArray(entries)) throw new Error("Supabase returned an invalid storage listing.");
      for (const entry of entries) {
        if (!entry || typeof entry.name !== "string" || !entry.name) continue;
        const path = `${prefix}${entry.name}`;
        if (!entry.id) await visitFolder(`${path}/`, depth + 1);
        else paths.push(path);
      }
      if (entries.length < STORAGE_PAGE_SIZE) break;
      offset += STORAGE_PAGE_SIZE;
    }
  };

  await visitFolder(`${userId}/`, 0);
  return paths;
}

async function removeOwnedStorageObjects(
  supabaseUrl: string,
  serviceRoleKey: string,
  paths: string[],
): Promise<void> {
  for (let start = 0; start < paths.length; start += STORAGE_DELETE_BATCH_SIZE) {
    const response = await fetch(`${supabaseUrl}/storage/v1/object/${encodeURIComponent(STORAGE_BUCKET)}`, {
      method: "DELETE",
      headers: storageHeaders(serviceRoleKey),
      body: JSON.stringify({ prefixes: paths.slice(start, start + STORAGE_DELETE_BATCH_SIZE) }),
    });
    if (!response.ok) throw new Error(await responseError(response));
  }
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return jsonResponse({}, 204, origin);
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Account deletion is not configured on the server." }, 500, origin);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return jsonResponse({ error: "A signed-in session is required." }, 401, origin);

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
    });
    if (!userResponse.ok) return jsonResponse({ error: "The signed-in session could not be verified." }, 401, origin);
    const user = await userResponse.json() as { id?: string };
    if (!user.id) return jsonResponse({ error: "The signed-in user could not be identified." }, 401, origin);

    const storagePaths = await listOwnedStorageObjects(supabaseUrl, serviceRoleKey, user.id);
    await removeOwnedStorageObjects(supabaseUrl, serviceRoleKey, storagePaths);

    const deleteResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
      method: "DELETE",
      headers: storageHeaders(serviceRoleKey),
    });
    if (!deleteResponse.ok) throw new Error(await responseError(deleteResponse));

    return jsonResponse({ success: true }, 200, origin);
  } catch (error) {
    console.error("[delete-account] Account deletion failed:", error);
    return jsonResponse({ error: "تعذر حذف الحساب وبياناته. حاول مجدداً أو تواصل مع الدعم." }, 500, origin);
  }
});
