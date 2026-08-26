"use client";

import * as React from "react";
import { toast as sonnerToast } from "sonner";

export type ToastVariant = "success" | "error" | "info" | "loading";

interface ToastOptions {
  id?: string;
  detail?: string;
  duration?: number;
}

interface ToastApi {
  success(message: string, opts?: ToastOptions): string;
  error(message: string, opts?: ToastOptions): string;
  info(message: string, opts?: ToastOptions): string;
  loading(message: string, opts?: ToastOptions): string;
  dismiss(id: string): void;
  dismissAll(): void;
}

function fire(variant: ToastVariant, message: string, opts: ToastOptions = {}): string {
  const sonnerOpts: { description?: string; duration?: number; id?: string } = {};
  if (opts.detail !== undefined) sonnerOpts.description = opts.detail;
  if (opts.duration !== undefined) sonnerOpts.duration = opts.duration;
  if (opts.id !== undefined) sonnerOpts.id = opts.id;

  switch (variant) {
    case "success":
      return String(sonnerToast.success(message, sonnerOpts));
    case "error":
      return String(sonnerToast.error(message, sonnerOpts));
    case "info":
      return String(sonnerToast.info(message, sonnerOpts));
    case "loading":
      return String(sonnerToast.loading(message, sonnerOpts));
  }
}

const toastApi: ToastApi = {
  success: (m, o) => fire("success", m, o),
  error: (m, o) => fire("error", m, o),
  info: (m, o) => fire("info", m, o),
  loading: (m, o) => fire("loading", m, o),
  dismiss: (id) => sonnerToast.dismiss(id),
  dismissAll: () => sonnerToast.dismiss(),
};

export function useToast(): ToastApi {
  return toastApi;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * Bridge from an action result ({ notice?, error? } — `useActionState` or
 * `useAction`) to toasts: fires a success/error toast whenever the action's
 * notice/error changes. Convention: transient action outcomes → toast via
 * this hook; validation errors → inline, adjacent to the field. Pass a slice
 * (e.g. `{ notice: state.notice }`) to toast only one side and keep the
 * other inline.
 */
export function useActionStateToast(
  state: { notice?: string; error?: string },
  opts: { successHint?: string; errorHint?: string } = {},
) {
  const prevNoticeRef = React.useRef<string | undefined>(undefined);
  const prevErrorRef = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    if (state.notice && state.notice !== prevNoticeRef.current) {
      toastApi.success(opts.successHint ?? state.notice);
      prevNoticeRef.current = state.notice;
    }
    if (state.error && state.error !== prevErrorRef.current) {
      toastApi.error(opts.errorHint ?? state.error);
      prevErrorRef.current = state.error;
    }
  }, [state.notice, state.error, opts.successHint, opts.errorHint]);
}
