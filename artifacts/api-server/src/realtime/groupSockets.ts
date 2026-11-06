import type { Server, Socket } from "socket.io";
import {
  authenticateToken,
  isGroupMember,
  sendGroupMessage,
  type AuthenticatedUser,
  type GroupConversation,
  type GroupMessage,
} from "../lib/groupService";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let io: Server | null = null;

type GroupSocket = Socket & { data: { user?: AuthenticatedUser } };

export function configureGroupSockets(socketServer: Server): void {
  io = socketServer;

  io.use((socket, next) => {
    const token = typeof socket.handshake.auth?.token === "string"
      ? socket.handshake.auth.token
      : "";
    void authenticateToken(token).then(user => {
      if (!user) {
        next(new Error("يجب تسجيل الدخول للاتصال بالرسائل الجماعية."));
        return;
      }
      socket.data.user = user;
      next();
    }).catch(() => next(new Error("تعذر التحقق من جلسة الحساب.")));
  });

  io.on("connection", socket => {
    const currentSocket = socket as GroupSocket;
    const user = currentSocket.data.user;
    if (!user) {
      socket.disconnect(true);
      return;
    }
    void socket.join(user.id);

    socket.on("join_group", (payload: unknown, acknowledge?: (result: { success: boolean; error?: string }) => void) => {
      const groupId = typeof payload === "string"
        ? payload
        : payload && typeof payload === "object" && "groupId" in payload && typeof payload.groupId === "string"
          ? payload.groupId
          : "";
      if (!UUID_PATTERN.test(groupId)) {
        acknowledge?.({ success: false, error: "معرّف المجموعة غير صالح." });
        return;
      }
      void isGroupMember(user, groupId).then(async isMember => {
        if (!isMember) {
          acknowledge?.({ success: false, error: "لا تملك صلاحية الوصول إلى هذه المجموعة." });
          return;
        }
        await socket.join(groupId);
        acknowledge?.({ success: true });
      }).catch(() => acknowledge?.({ success: false, error: "تعذر الانضمام إلى المجموعة." }));
    });

    socket.on("send_group_message", (
      payload: unknown,
      acknowledge?: (result: { success: boolean; message?: GroupMessage; error?: string }) => void,
    ) => {
      const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const groupId = typeof data.groupId === "string" ? data.groupId : "";
      const content = typeof data.content === "string" ? data.content.trim() : "";
      if (!UUID_PATTERN.test(groupId) || !content || content.length > 4000) {
        acknowledge?.({ success: false, error: "الرسالة أو معرّف المجموعة غير صالح." });
        return;
      }
      void sendGroupMessage(user, groupId, content).then(message => {
        io?.to(groupId).emit("receive_group_message", message);
        acknowledge?.({ success: true, message });
      }).catch(error => {
        const message = error instanceof Error ? error.message : "تعذر إرسال الرسالة.";
        acknowledge?.({ success: false, error: message });
      });
    });
  });
}

export function emitGroupCreated(group: GroupConversation): void {
  if (!io) return;
  group.members.forEach(userId => io?.to(userId).emit("group_created", group));
}

export function emitGroupMessage(message: GroupMessage): void {
  io?.to(message.groupId).emit("receive_group_message", message);
}
