import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

import { supabase } from '@/lib/supabase';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeGroup(value: unknown): GroupConversation | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.creatorId !== 'string'
    || !Array.isArray(value.members)) return null;
  return {
    id: value.id,
    name: value.name,
    creatorId: value.creatorId,
    members: value.members.filter((member): member is string => typeof member === 'string'),
    avatar: typeof value.avatar === 'string' ? value.avatar : value.name.trim().slice(0, 1),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
  };
}

function normalizeGroupMessage(value: unknown): GroupMessage | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.groupId !== 'string'
    || typeof value.senderId !== 'string'
    || typeof value.content !== 'string') return null;
  return {
    id: value.id,
    groupId: value.groupId,
    senderId: value.senderId,
    content: value.content,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
  };
}

async function groupApiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data, error } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (error || !token) throw new Error('انتهت جلسة الدخول. سجّل الدخول مجدداً ثم حاول مرة أخرى.');

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(result) && typeof result.error === 'string'
      ? result.error
      : 'تعذر إكمال طلب المجموعات الآن.';
    throw new Error(message);
  }
  return result as T;
}

function mergeMessage(current: GroupMessage[] | null | undefined, next: GroupMessage): GroupMessage[] {
  const currentMessages = Array.isArray(current)
    ? current.filter(message => Boolean(message && typeof message.id === 'string' && typeof message.createdAt === 'string'))
    : [];
  if (currentMessages.some(message => message.id === next.id)) return currentMessages;
  return [...currentMessages, next].sort((first, second) => first.createdAt.localeCompare(second.createdAt));
}

export default function useGroupConversations(currentUserId: string, selectedGroupId: string | null) {
  const [groups, setGroups] = useState<GroupConversation[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [groupMessages, setGroupMessages] = useState<GroupMessage[]>([]);
  const [groupMessagesLoading, setGroupMessagesLoading] = useState(false);
  const [groupMessagesError, setGroupMessagesError] = useState<string | null>(null);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const groupsRef = useRef<GroupConversation[]>([]);
  const selectedGroupIdRef = useRef<string | null>(selectedGroupId);

  useEffect(() => {
    groupsRef.current = Array.isArray(groups) ? groups : [];
  }, [groups]);

  useEffect(() => {
    selectedGroupIdRef.current = selectedGroupId;
  }, [selectedGroupId]);

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true);
    setGroupsError(null);
    try {
      const result = await groupApiRequest<unknown>('/api/groups');
      const nextGroups = Array.isArray(result)
        ? result.filter(Boolean).map(normalizeGroup).filter((group): group is GroupConversation => group !== null)
        : [];
      setGroups(nextGroups);
    } catch (error) {
      console.error('[messages] تعذر تحميل المجموعات:', error);
      setGroupsError(error instanceof Error ? error.message : 'تعذر تحميل المجموعات الآن.');
      setGroups([]);
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  useEffect(() => {
    setGroups([]);
    setGroupMessages([]);
    void loadGroups();
  }, [currentUserId, loadGroups]);

  useEffect(() => {
    let active = true;
    let socket: ReturnType<typeof io> | null = null;

    void Promise.resolve().then(() => supabase.auth.getSession()).then(({ data, error }) => {
      if (!active || typeof window === 'undefined' || error || !data.session?.access_token) return;
      const socketOrigin = window.location.origin || `${window.location.protocol}//${window.location.host}`;
      if (!socketOrigin || socketOrigin === 'null') return;

      socket = io(socketOrigin, {
        autoConnect: false,
        path: '/api/socket.io',
        auth: { token: data.session.access_token },
      });
      socketRef.current = socket;
      socket.on('connect', () => {
        const currentGroups = Array.isArray(groupsRef.current) ? groupsRef.current : [];
        currentGroups.forEach(group => group?.id && socket?.emit('join_group', group.id));
      });
      socket.on('group_created', (payload: unknown) => {
        const group = normalizeGroup(payload);
        if (!group) return;
        setGroups(current => {
          const currentGroups = Array.isArray(current) ? current : [];
          return [group, ...currentGroups.filter(existing => existing?.id !== group.id)];
        });
        socket?.emit('join_group', group.id);
      });
      socket.on('receive_group_message', (payload: unknown) => {
        const message = normalizeGroupMessage(payload);
        if (!message || message.groupId !== selectedGroupIdRef.current) return;
        setGroupMessages(current => mergeMessage(current, message));
      });
      socket.connect();
    }).catch(error => {
      console.error('[messages] تعذر فتح اتصال الرسائل الجماعية:', error);
    });

    return () => {
      active = false;
      socket?.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [currentUserId]);

  useEffect(() => {
    const socket = socketRef.current;
    const currentGroups = Array.isArray(groups) ? groups : [];
    if (socket?.connected) {
      currentGroups.forEach(group => group?.id && socket.emit('join_group', group.id));
    }
  }, [groups]);

  useEffect(() => {
    let active = true;
    setGroupMessages([]);
    setGroupMessagesError(null);
    if (!selectedGroupId) {
      setGroupMessagesLoading(false);
      return () => { active = false; };
    }

    setGroupMessagesLoading(true);
    void groupApiRequest<unknown>(`/api/groups/${encodeURIComponent(selectedGroupId)}/messages`)
      .then(result => {
        if (!active) return;
        const messages = Array.isArray(result)
          ? result.filter(Boolean).map(normalizeGroupMessage).filter((message): message is GroupMessage => message !== null)
          : [];
        setGroupMessages(current => {
          const currentMessages = Array.isArray(current) ? current : [];
          return messages.reduce((merged, message) => mergeMessage(merged, message), currentMessages);
        });
      })
      .catch(error => {
        if (!active) return;
        setGroupMessagesError(error instanceof Error ? error.message : 'تعذر تحميل رسائل المجموعة.');
      })
      .finally(() => {
        if (active) setGroupMessagesLoading(false);
      });

    return () => { active = false; };
  }, [selectedGroupId]);

  const createGroup = useCallback(async (name: string, memberIds: string[]) => {
    setGroupsError(null);
    const result = await groupApiRequest<unknown>('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ name, members: memberIds }),
    });
    const group = normalizeGroup(result);
    if (!group) throw new Error('أُنشئت المجموعة لكن تعذر قراءة بياناتها.');
    setGroups(current => {
      const currentGroups = Array.isArray(current) ? current : [];
      return [group, ...currentGroups.filter(existing => existing?.id !== group.id)];
    });
    socketRef.current?.emit('join_group', group.id);
    return group;
  }, []);

  const sendGroupMessage = useCallback(async (groupId: string, content: string) => {
    const result = await groupApiRequest<unknown>(`/api/groups/${encodeURIComponent(groupId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    const message = normalizeGroupMessage(result);
    if (!message) throw new Error('تم الإرسال لكن تعذر قراءة الرسالة المحفوظة.');
    if (selectedGroupIdRef.current === groupId) {
      setGroupMessages(current => mergeMessage(current, message));
    }
    return message;
  }, []);

  return {
    groups,
    setGroups,
    groupsLoading,
    groupsError,
    loadGroups,
    groupMessages,
    groupMessagesLoading,
    groupMessagesError,
    createGroup,
    sendGroupMessage,
  };
}
