"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_RANGE, RANGES, type DashboardRange } from "./dashboardRange";

export function DashboardRangeSelector({ current }: { current: DashboardRange }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams);
    if (value === DEFAULT_RANGE) {
      params.delete("range");
    } else {
      params.set("range", value);
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `/dashboard?${qs}` : "/dashboard", { scroll: false });
    });
  }

  return (
    <div data-dashboard-filters="ready">
      <Select value={current} onValueChange={onChange}>
        <SelectTrigger
          aria-label="Dashboard time range"
          className="h-9 w-auto min-w-[140px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {RANGES.map((r) => (
            <SelectItem key={r.value} value={r.value}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
