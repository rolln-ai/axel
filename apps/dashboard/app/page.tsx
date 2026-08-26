import { redirect } from "next/navigation";
import { getSetupProblem } from "../lib/config";
import { getAuthenticatedUser, getCurrentSession } from "../lib/session";

export default async function Page() {
  if (getSetupProblem()) redirect("/login");
  const session = await getCurrentSession();
  if (session) redirect("/dashboard");
  // getCurrentSession() is also null for a signed-in user with zero workspaces
  // (e.g. just deleted their last one). Route them to onboarding, mirroring the
  // (app) layout, instead of an unexplained /login bounce.
  const auth = await getAuthenticatedUser();
  redirect(auth ? "/welcome" : "/login");
}
