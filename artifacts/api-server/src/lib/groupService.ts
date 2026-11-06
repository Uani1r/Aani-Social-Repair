export interface AuthenticatedUser {
  id: string;
  accessToken: string;
}

export interface GroupConversation {
  id: string;
  name: string;
  creatorId: string;
  members: string[];
  avatar: string;
  createdAt: string;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  senderId: string;
  content: string;
  createdAt: string;
}

export class GroupServiceError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message);
    this.name = "GroupServiceError";
  }
}

const SUPABASE_URL = (
  process.env.SUPABASE_URL
  || process.env.VITE_SUPABASE_URL
  || "https://whvhxgfdumxzunzsjkll.supabase.co"
).replace(/\/$/, "");
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  || process.env.VITE_SUPABASE_ANON_KEY
  || "sb_publishable_uY5fTNffiCtUgKnrTLu6rA_KOoaS18j";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

async function supabaseFetch<T>(
  path: string,
  user: AuthenticatedUser,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers({
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${user.accessToken}`,
      Accept: "application/json",
    });
    if (init.body) headers.set("Content-Type", "application/json");
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    response = await fetch(`${SUPABASE_URL}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new GroupServiceError("تعذر الاتصال بقاعدة البيانات حالياً.", 503);
  }

  const data = await parseResponse(response);
  if (!response.ok) {
    const details = isRecord(data)
      ? (typeof data.message === "string" ? data.message : typeof data.error_description === "string" ? data.error_description : null)
      : null;
    const status = response.status === 401 || response.status === 403
      ? response.status
      : response.status >= 500 ? 502 : 400;
    throw new GroupServiceError(details || "تعذر تنفيذ العملية على قاعدة البيانات.", status);
  }
  return data as T;
}

export async function authenticateToken(accessToken: string): Promise<AuthenticatedUser | null> {
  if (!accessToken) return null;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!isRecord(data) || typeof data.id !== "string") return null;
    return { id: data.id, accessToken };
  } catch {
    return null;
  }
}

export async function getAuthenticatedUser(authorization: string | undefined): Promise<AuthenticatedUser | null> {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match ? authenticateToken(match[1].trim()) : null;
}

export async function createGroup(
  user: AuthenticatedUser,
  name: string,
  memberIds: string[],
): Promise<GroupConversation> {
  return supabaseFetch<GroupConversation>("/rest/v1/rpc/aani_create_group", user, {
    method: "POST",
    body: JSON.stringify({ p_name: name, p_member_ids: memberIds }),
  });
}

export async function listGroups(user: AuthenticatedUser): Promise<GroupConversation[]> {
  const groups = await supabaseFetch<unknown>("/rest/v1/rpc/aani_get_my_groups", user, {
    method: "POST",
    body: "{}",
  });
  return Array.isArray(groups) ? groups as GroupConversation[] : [];
}

export async function isGroupMember(user: AuthenticatedUser, groupId: string): Promise<boolean> {
  const query = new URLSearchParams({
    select: "group_id",
    group_id: `eq.${groupId}`,
    user_id: `eq.${user.id}`,
    limit: "1",
  });
  const rows = await supabaseFetch<unknown>(`/rest/v1/group_members?${query.toString()}`, user);
  return Array.isArray(rows) && rows.length > 0;
}

export async function listGroupMessages(user: AuthenticatedUser, groupId: string): Promise<GroupMessage[]> {
  if (!await isGroupMember(user, groupId)) {
    throw new GroupServiceError("لا تملك صلاحية الوصول إلى هذه المجموعة.", 403);
  }
  const query = new URLSearchParams({
    select: "id,group_id,sender_id,content,created_at",
    group_id: `eq.${groupId}`,
    order: "created_at.desc,id.desc",
    limit: "1000",
  });
  const rows = await supabaseFetch<Array<Record<string, unknown>>>(`/rest/v1/group_messages?${query.toString()}`, user);
  return rows.reverse().map(row => ({
    id: String(row.id),
    groupId: String(row.group_id),
    senderId: String(row.sender_id),
    content: String(row.content || ""),
    createdAt: String(row.created_at),
  }));
}

export async function sendGroupMessage(
  user: AuthenticatedUser,
  groupId: string,
  content: string,
): Promise<GroupMessage> {
  const rows = await supabaseFetch<Array<Record<string, unknown>>>(
    "/rest/v1/group_messages?select=id,group_id,sender_id,content,created_at",
    user,
    {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ group_id: groupId, sender_id: user.id, content }),
    },
  );
  const row = rows[0];
  if (!row) throw new GroupServiceError("لم يتم حفظ الرسالة.", 502);
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    senderId: String(row.sender_id),
    content: String(row.content || ""),
    createdAt: String(row.created_at),
  };
}
