"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CreateDestinationForm } from "./CreateDestinationForm";

/**
 * Modal wrapper around CreateDestinationForm.
 *
 * Unlike the source dialog (which keeps the modal open so the operator can
 * copy the one-time token), the destination dialog auto-dismisses ~1.2s
 * after a successful create — no secret needs to stay on screen, and the
 * underlying table refreshes via router.refresh() on close.
 */
export function NewDestinationDialog({
  disabledReason,
}: {
  /** When set, the open button is disabled and we surface this as a tooltip. */
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get("create") === "1" && !disabledReason) {
      setOpen(true);
    }
  }, [disabledReason, searchParams]);

  function clearCreateParam() {
    if (searchParams.get("create") !== "1") return;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("create");
    const suffix = nextParams.toString();
    router.replace(`/destinations${suffix ? `?${suffix}` : ""}`, { scroll: false });
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      router.refresh();
      clearCreateParam();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button disabled={Boolean(disabledReason)} title={disabledReason}>
          <Plus className="size-4" />
          New destination
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New destination</DialogTitle>
          <DialogDescription>
            Pick a type, fill in the connection details, and Axel encrypts the secrets before they hit the database.
          </DialogDescription>
        </DialogHeader>
        <CreateDestinationForm
          onSuccess={({ hasSecretToDisplay }) => {
            // For most destinations: dismiss after a beat so the success
            // notice flashes and the table refreshes. For webhook
            // destinations with a freshly-generated signing secret, stay
            // open — the secret is shown ONCE and the operator must copy
            // it now or rotate it later.
            if (hasSecretToDisplay) return;
            setTimeout(() => setOpen(false), 1200);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
