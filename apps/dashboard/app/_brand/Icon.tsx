import * as React from "react";
import {
  LayoutGrid,
  Inbox,
  SendHorizontal,
  Workflow,
  ListChecks,
  BarChart3,
  Users,
  Settings as LucideSettings,
  Search,
  Plus,
  ChevronDown,
  Bell,
  TrendingUp,
  TrendingDown,
  type LucideIcon,
} from "lucide-react";

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, "ref"> {
  size?: number;
  strokeWidth?: number;
}

function makeIcon(LucideComp: LucideIcon) {
  return function Icon({ size = 16, strokeWidth = 1.6, ...rest }: IconProps) {
    return (
      <LucideComp
        width={size}
        height={size}
        strokeWidth={strokeWidth}
        aria-hidden="true"
        {...rest}
      />
    );
  };
}

export const IconOverview = makeIcon(LayoutGrid);
export const IconSources = makeIcon(Inbox);
export const IconDestinations = makeIcon(SendHorizontal);
export const IconRoutes = makeIcon(Workflow);
export const IconDeliveries = makeIcon(ListChecks);
export const IconUsage = makeIcon(BarChart3);
export const IconTeam = makeIcon(Users);
export const IconSettings = makeIcon(LucideSettings);
export const IconSearch = makeIcon(Search);
export const IconPlus = makeIcon(Plus);
export const IconChevron = makeIcon(ChevronDown);
export const IconBell = makeIcon(Bell);
export const IconTrendingUp = makeIcon(TrendingUp);
export const IconTrendingDown = makeIcon(TrendingDown);
