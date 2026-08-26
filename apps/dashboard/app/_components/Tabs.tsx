"use client";

import * as React from "react";
import { Tabs as ShadTabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export interface TabItem {
  key: string;
  label: string;
  content: React.ReactNode;
}

export function Tabs({
  items,
  defaultKey,
  ariaLabel,
}: {
  items: TabItem[];
  defaultKey?: string;
  ariaLabel?: string;
}) {
  const initial = defaultKey ?? items[0]?.key ?? "";
  return (
    <ShadTabs defaultValue={initial} className="w-full">
      <TabsList aria-label={ariaLabel}>
        {items.map((item) => (
          <TabsTrigger key={item.key} value={item.key}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {items.map((item) => (
        <TabsContent key={item.key} value={item.key} className="mt-4">
          {item.content}
        </TabsContent>
      ))}
    </ShadTabs>
  );
}
