function jsonResponse(body: Record<string, unknown>, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
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

function serviceHeaders(serviceRoleKey: string): HeadersInit {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin ?? "*",
        "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
      },
    });
  }
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Phone update is not configured on the server." }, 500, origin);
  }

  const accessToken = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return jsonResponse({ error: "A signed-in session is required." }, 401, origin);

  let phone: unknown;
  try {
    const body = await request.json() as { phone?: unknown };
    phone = body.phone;
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400, origin);
  }
  if (typeof phone !== "string" || !/^\+[1-9]\d{7,14}$/.test(phone)) {
    return jsonResponse({ error: "Enter a phone number in international format." }, 400, origin);
  }

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
    });
    if (!userResponse.ok) return jsonResponse({ error: "The signed-in session could not be verified." }, 401, origin);
    const user = await userResponse.json() as { id?: string };
    if (!user.id) return jsonResponse({ error: "The signed-in user could not be identified." }, 401, origin);

    const updateResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
      method: "PUT",
      headers: serviceHeaders(serviceRoleKey),
      body: JSON.stringify({ phone, phone_confirm: true }),
    });
    if (!updateResponse.ok) {
      const errorBody = await updateResponse.text();
      console.error("[update-account-phone] Auth update failed:", updateResponse.status, errorBody);
      return jsonResponse({ error: "تعذر تحديث رقم الهاتف. تحقق من الرقم وحاول مجدداً." }, 400, origin);
    }

    return jsonResponse({ phone }, 200, origin);
  } catch (error) {
    console.error("[update-account-phone] Phone update failed:", error);
    return jsonResponse({ error: "تعذر تحديث رقم الهاتف مباشرة." }, 500, origin);
  }
});
