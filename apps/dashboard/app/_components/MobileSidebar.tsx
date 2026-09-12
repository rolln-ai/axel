"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function MobileSidebar({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const pathname = usePathname();
  const search = useSearchParams().toString();
  React.useEffect(() => setReady(true), []);
  React.useEffect(() => setOpen(false), [pathname, search]);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="fixed top-3 left-3 z-30 md:hidden"
          aria-label="Open menu"
          disabled={!ready}
        >
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-72 flex-col p-0 sm:max-w-sm">
        <SheetTitle className="sr-only">Workspace navigation</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
