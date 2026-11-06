import { Router, type IRouter, type Request, type Response } from "express";
import {
  createGroup,
  getAuthenticatedUser,
  GroupServiceError,
  listGroupMessages,
  listGroups,
  sendGroupMessage,
} from "../lib/groupService";
import { emitGroupCreated, emitGroupMessage } from "../realtime/groupSockets";

const router: IRouter = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function respondWithError(error: unknown, res: Response): void {
  if (error instanceof GroupServiceError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error("[groups] API request failed:", error);
  res.status(500).json({ error: "حدث خطأ غير متوقع أثناء معالجة المجموعة." });
}

async function requireUser(req: Request, res: Response) {
  const user = await getAuthenticatedUser(req.header("authorization"));
  if (!user) {
    res.status(401).json({ error: "يجب تسجيل الدخول لاستخدام المجموعات." });
    return null;
  }
  return user;
}

router.post("/groups", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const memberIds = req.body?.members;
    if (!name || name.length > 60 || !Array.isArray(memberIds) || memberIds.length === 0
      || memberIds.length > 100 || memberIds.some((id: unknown) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
      res.status(400).json({ error: "أدخل اسماً للمجموعة واختر عضواً واحداً على الأقل." });
      return;
    }

    const group = await createGroup(user, name, [...new Set(memberIds as string[])]);
    emitGroupCreated(group);
    res.status(201).json(group);
  } catch (error) {
    respondWithError(error, res);
  }
});

router.get("/groups", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    res.json(await listGroups(user));
  } catch (error) {
    respondWithError(error, res);
  }
});

router.post("/groups/:groupId/messages", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { groupId } = req.params;
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!UUID_PATTERN.test(groupId) || !content || content.length > 4000) {
      res.status(400).json({ error: "الرسالة أو معرّف المجموعة غير صالح." });
      return;
    }
    const message = await sendGroupMessage(user, groupId, content);
    emitGroupMessage(message);
    res.status(201).json(message);
  } catch (error) {
    respondWithError(error, res);
  }
});

router.get("/groups/:groupId/messages", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { groupId } = req.params;
    if (!UUID_PATTERN.test(groupId)) {
      res.status(400).json({ error: "معرّف المجموعة غير صالح." });
      return;
    }
    res.json(await listGroupMessages(user, groupId));
  } catch (error) {
    respondWithError(error, res);
  }
});

export default router;
