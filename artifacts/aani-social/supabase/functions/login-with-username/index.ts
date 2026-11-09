type LoginRequest = {
  username?: unknown;
  password?: unknown;
};

type ProfileRow = {
  id?: string;
};

type AuthUserResponse = {
  email?: string;
  user?: { email?: string };
};

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function jsonResponse(body: Record<string, unknown>, status: number, origin: string | null): Response {
  const headers = new Headers(corsHeaders(origin));
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

function serviceHeaders(serviceRoleKey: string): HeadersInit {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

function invalidCredentials(origin: string | null): Response {
  return jsonResponse({ error: "بيانات تسجيل الدخول غير صحيحة." }, 401, origin);
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "تسجيل الدخول غير متاح حالياً." }, 500, origin);
  }

  let body: LoginRequest;
  try {
    body = await request.json() as LoginRequest;
  } catch {
    return jsonResponse({ error: "بيانات الطلب غير صالحة." }, 400, origin);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "بيانات الطلب غير صالحة." }, 400, origin);
  }

  const username = typeof body.username === "string" ? body.username.trim().replace(/^@/, "").toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[a-z0-9_.]{3,32}$/.test(username) || !password || password.length > 1024) {
    return invalidCredentials(origin);
  }

  try {
    const profilesUrl = new URL(`${supabaseUrl}/rest/v1/profiles`);
    profilesUrl.searchParams.set("select", "id");
    profilesUrl.searchParams.set("username", `eq.${username}`);
    profilesUrl.searchParams.set("limit", "1");

    const profileResponse = await fetch(profilesUrl, {
      headers: serviceHeaders(serviceRoleKey),
    });
    if (!profileResponse.ok) {
      console.error("[login-with-username] Profile lookup failed:", profileResponse.status);
      return jsonResponse({ error: "تعذر إكمال تسجيل الدخول حالياً." }, 500, origin);
    }
    const profiles = await profileResponse.json() as ProfileRow[];
    const userId = Array.isArray(profiles) ? profiles[0]?.id : undefined;
    if (!userId) return invalidCredentials(origin);

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: serviceHeaders(serviceRoleKey),
    });
    if (!userResponse.ok) {
      console.error("[login-with-username] Auth user lookup failed:", userResponse.status);
      return invalidCredentials(origin);
    }
    const authUser = await userResponse.json() as AuthUserResponse;
    const email = authUser.user?.email ?? authUser.email;
    if (!email) return invalidCredentials(origin);

    const tokenResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    if (!tokenResponse.ok) return invalidCredentials(origin);

    const session = await tokenResponse.json() as Record<string, unknown>;
    if (typeof session.access_token !== "string" || typeof session.refresh_token !== "string") {
      console.error("[login-with-username] Auth returned an incomplete session.");
      return jsonResponse({ error: "تعذر إكمال تسجيل الدخول حالياً." }, 502, origin);
    }
    return jsonResponse(session, 200, origin);
  } catch (error) {
    console.error("[login-with-username] Sign-in failed:", error);
    return jsonResponse({ error: "تعذر إكمال تسجيل الدخول حالياً." }, 500, origin);
  }
});
