const OPTIONAL_MODERATION_RELATIONS = new Set(['comment_hides', 'user_restrictions']);
const unavailableOptionalRelations = new Set<string>();

function localIdsKey(kind: string, userId: string): string {
  return `aani:${kind}:v1:${encodeURIComponent(userId)}`;
}

function readIds(key: string): Set<string> {
  if (typeof window === 'undefined') return new Set();

  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeIds(key: string, ids: Set<string>): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(ids)));
  } catch {
    // Storage can be unavailable in private browsing or restricted contexts.
  }
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  return String((error as { code?: unknown }).code ?? '');
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const value = error as { message?: unknown; details?: unknown };
  return `${String(value.message ?? '')} ${String(value.details ?? '')}`;
}

export function isMissingOptionalModerationRelation(table: string, error: unknown): boolean {
  if (!OPTIONAL_MODERATION_RELATIONS.has(table)) return false;
  const code = errorCode(error);
  return code === 'PGRST205' || code === '42P01' || /could not find the table|relation .* does not exist/i.test(errorText(error));
}

export function isMissingOptionalModerationAction(action: string, error: unknown): boolean {
  if (action !== 'aani_set_user_restricted' && action !== 'aani_block_user') return false;
  const code = errorCode(error);
  return (
    code === 'PGRST202' ||
    code === 'PGRST205' ||
    code === '42P01' ||
    code === '42883' ||
    /could not find the (table|function)|function .* does not exist|relation .* does not exist/i.test(errorText(error))
  );
}

export function markOptionalModerationRelationUnavailable(table: string): void {
  if (OPTIONAL_MODERATION_RELATIONS.has(table)) unavailableOptionalRelations.add(table);
}

export function isOptionalModerationRelationUnavailable(table: string): boolean {
  return unavailableOptionalRelations.has(table);
}

export function readLocalCommentHideIds(userId: string): Set<string> {
  return userId ? readIds(localIdsKey('comment-hides', userId)) : new Set();
}

export function writeLocalCommentHideIds(userId: string, ids: Set<string>): void {
  if (userId) writeIds(localIdsKey('comment-hides', userId), ids);
}

export function readLocalRestrictedUserIds(userId: string): Set<string> {
  return userId ? readIds(localIdsKey('restricted-users', userId)) : new Set();
}

export function writeLocalRestrictedUserIds(userId: string, ids: Set<string>): void {
  if (userId) writeIds(localIdsKey('restricted-users', userId), ids);
}

export function readLocalBlockedUserIds(userId: string): Set<string> {
  return userId ? readIds(localIdsKey('blocked-users', userId)) : new Set();
}

export function writeLocalBlockedUserIds(userId: string, ids: Set<string>): void {
  if (userId) writeIds(localIdsKey('blocked-users', userId), ids);
}

export function readLocalMutedUserIds(userId: string): Set<string> {
  if (typeof window === 'undefined' || !userId) return new Set();
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(`aani_message_preferences_${userId}`) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return new Set();
    const ids = (stored as Record<string, unknown>).mutedIds;
    return Array.isArray(ids) ? new Set(ids.filter((value): value is string => typeof value === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function writeLocalMutedUserIds(userId: string, ids: Set<string>): void {
  if (typeof window === 'undefined' || !userId) return;
  try {
    const storageKey = `aani_message_preferences_${userId}`;
    const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    const preferences = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? stored as Record<string, unknown>
      : {};
    window.localStorage.setItem(storageKey, JSON.stringify({ ...preferences, mutedIds: [...ids] }));
  } catch {
    // Storage can be unavailable in private browsing or restricted contexts.
  }
}
