// Synthetic credentials are valid only in the disposable QA database.
export const qaPassword = "Axel-QA-Only-2026";
export const qaProjects = ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"];

export function dashboardFixture(project) {
  if (!qaProjects.includes(project)) throw new Error("Unknown dashboard QA project");
  const suffix = project.replaceAll("-", "_");
  return {
    userId: `usr_qa_${suffix}`,
    email: `${project}@example.test`,
    workspaceId: `ws_qa_${suffix}`,
    workspaceName: `Synthetic ${project}`,
    sourceId: `src_qa_${suffix}`,
    investigationId: 900000 + qaProjects.indexOf(project),
  };
}
