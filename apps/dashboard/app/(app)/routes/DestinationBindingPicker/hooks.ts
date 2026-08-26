"use client";

import { useEffect, useState, useTransition } from "react";
import { listDestinationTargets } from "../../../../lib/destination-binding-actions";

/**
 * Load / reload state machine for a destination's live target list
 * (tables / collections / Delta tables). Fetches on mount with an `active`
 * guard so a picker unmounted mid-flight never sets state.
 */
export function useTargetList(destinationId: string) {
  const [targets, setTargets] = useState<string[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    listDestinationTargets(destinationId)
      .then((result) => {
        if (!active) return;
        if (result.ok) setTargets(result.targets);
        else setLoadErr(result.error);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [destinationId]);

  function reload() {
    setLoading(true);
    setLoadErr(null);
    listDestinationTargets(destinationId)
      .then((result) => {
        if (result.ok) setTargets(result.targets);
        else setLoadErr(result.error);
      })
      .finally(() => setLoading(false));
  }

  return { targets, setTargets, loadErr, loading, reload };
}

/**
 * Auto-select a just-created target once it's mounted as a <SelectItem>.
 * Selecting it in the same commit that adds the item races Radix's item
 * registration and leaves the trigger on its placeholder; deferring to a
 * later render (after the item mounts) makes the pick stick.
 *
 * Returns the setter that arms the pending selection.
 */
export function usePendingSelect(
  targets: string[] | null,
  setSelected: (name: string) => void,
) {
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  useEffect(() => {
    if (pendingSelect && targets?.includes(pendingSelect)) {
      setSelected(pendingSelect);
      setPendingSelect(null);
    }
  }, [pendingSelect, targets, setSelected]);
  return setPendingSelect;
}

/**
 * The full pick-or-create state machine shared by the Postgres and Mongo
 * pickers (and partially by Databricks SQL, which has no create flow):
 *
 *  - `selected` holds the picked existing target; `draft` holds a typed
 *    new-target name. The effective target is the draft (if any) else the
 *    selection — mirrors NewDestinationTargetPicker.
 *  - `pick` applies a dropdown choice and clears the draft so the two
 *    inputs never bleed into each other.
 *  - `runCreate` drives the inline create flow and defers the auto-select
 *    of the new target to usePendingSelect (post item-mount).
 */
export function useTargetPicker(destinationId: string, initialSelected: string) {
  const list = useTargetList(destinationId);
  const [selected, setSelected] = useState(initialSelected);
  const [draft, setDraft] = useState("");
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const setPendingSelect = usePendingSelect(list.targets, setSelected);

  const target = draft.trim() || selected;

  function pick(name: string) {
    setSelected(name);
    setDraft("");
  }

  function runCreate(
    create: (name: string) => Promise<{ ok: true; name: string } | { ok: false; error: string }>,
  ) {
    setCreateSuccess(null);
    setCreateError(null);
    startTransition(async () => {
      const result = await create(target);
      if (result.ok) {
        setCreateSuccess(`Created "${result.name}"`);
        setCreateError(null);
        setDraft("");
        list.setTargets((prev) =>
          prev && prev.includes(result.name) ? prev : [...(prev ?? []), result.name],
        );
        // Defer the auto-select to usePendingSelect (post item-mount).
        setPendingSelect(result.name);
      } else {
        setCreateError(`✗ ${result.error}`);
        setCreateSuccess(null);
      }
    });
  }

  return {
    ...list,
    selected,
    setSelected,
    draft,
    setDraft,
    target,
    pick,
    createSuccess,
    createError,
    pending,
    runCreate,
  };
}
