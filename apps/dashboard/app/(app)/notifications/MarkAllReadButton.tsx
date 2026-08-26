"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { markAllNotificationsReadAction } from "./actions";
import { useAction } from "../../_components/useAction";

export function MarkAllReadButton() {
  const router = useRouter();
  const markAll = useAction(markAllNotificationsReadAction, {
    onSuccess: () => router.refresh(),
  });
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={markAll.pending}
      onClick={() => markAll.run()}
    >
      {markAll.pending ? "Marking…" : "Mark all read"}
    </Button>
  );
}
