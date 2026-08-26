"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "../../../lib/session";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "../../../lib/notifications";

export async function markAllNotificationsReadAction(): Promise<{ count: number }> {
  const session = await requireSession();
  const count = await markAllNotificationsRead(
    session.activeWorkspace.workspace_id,
    session.user.id,
  );
  revalidatePath("/notifications");
  revalidatePath("/", "layout");
  return { count };
}

export async function markNotificationReadAction(id: string): Promise<void> {
  const session = await requireSession();
  await markNotificationRead(
    id,
    session.activeWorkspace.workspace_id,
    session.user.id,
  );
  revalidatePath("/notifications");
  revalidatePath("/", "layout");
}
