import { PageHeaderSkeleton } from "@/app/_components/PageHeader";
import { NavigationProgress } from "@/app/_components/NavigationProgress";
import { Section } from "@/app/_components/Section";
import { Skeleton } from "@/components/ui/skeleton";

export default function GrowthLoading() {
  return (
    <div aria-busy="true" aria-label="Loading cloud adoption">
      <NavigationProgress />
      <PageHeaderSkeleton />
      <Section title="Signup to delivery">
        <div aria-hidden="true" className="space-y-3">
          {[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-7 w-full" />)}
          <Skeleton className="h-8 w-full" />
        </div>
      </Section>
      <Section title="What these numbers include">
        <Skeleton className="h-16 w-full" />
      </Section>
    </div>
  );
}
