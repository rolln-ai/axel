"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";

interface ConfirmActionProps {
  title: string;
  /** The confirmation question — keep it identical to the action's stakes. */
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive tone on the confirm button. */
  destructive?: boolean;
  /**
   * Called when the user confirms. Omit it to submit the trigger's enclosing
   * `<form action={…}>` instead (the common server-action case).
   */
  onConfirm?: () => void;
  /** Controlled mode — for dropdown-menu items and imperative openers. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Trigger element, rendered via `asChild`. Must be `type="button"` when it
   * lives inside the form it confirms, so the click opens the dialog instead
   * of submitting.
   */
  children?: React.ReactNode;
}

/**
 * The one confirmation primitive for destructive / irreversible actions.
 * Replaces the previous mix of `window.confirm`, bespoke Radix Dialogs, and
 * inline arm/confirm pairs with a single shadcn AlertDialog.
 *
 * Two shapes:
 *
 *   - Trigger mode: wrap the action button; on confirm the enclosing form is
 *     submitted via `requestSubmit()` (or `onConfirm` runs, when given).
 *   - Controlled mode: pass `open`/`onOpenChange` and no children — used from
 *     `DropdownMenuItem onSelect` (the menu unmounts its content on select,
 *     so the dialog and the submitted form must live outside it).
 *
 * Typed-name deletion dialogs (e.g. "type the workspace name to confirm")
 * are a deliberate heavier tier and stay as full Dialogs.
 */
export function ConfirmAction({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  open,
  onOpenChange,
  children,
}: ConfirmActionProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  const isControlled = open !== undefined;
  const actualOpen = isControlled ? open : uncontrolledOpen;

  function setOpen(next: boolean) {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <AlertDialog open={actualOpen} onOpenChange={setOpen}>
      {children !== undefined ? (
        <AlertDialogTrigger
          asChild
          onClick={(event) => {
            // Remember the enclosing form so Confirm can submit it. Captured
            // at click time — the trigger is the only reliable link to it.
            formRef.current = (event.currentTarget as HTMLElement).closest("form");
          }}
        >
          {children}
        </AlertDialogTrigger>
      ) : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className={destructive ? buttonVariants({ variant: "destructive" }) : undefined}
            onClick={() => {
              if (onConfirm) onConfirm();
              else formRef.current?.requestSubmit();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
