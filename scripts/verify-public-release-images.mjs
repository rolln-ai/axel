import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function verifyPublicImage(repository, version, fetchImpl = fetch) {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(repository)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid release image reference");
  }
  const tokenResponse = await fetchImpl(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`, {
    redirect: "error", signal: AbortSignal.timeout(10000),
  });
  if (!tokenResponse.ok) throw new Error("Anonymous registry token request failed");
  const { token } = await tokenResponse.json();
  if (typeof token !== "string" || !token) throw new Error("Anonymous registry token is missing");
  const response = await fetchImpl(`https://ghcr.io/v2/${repository}/manifests/${version}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
    },
    redirect: "error", signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`Image ${repository}:${version} is not anonymously readable. Make the GitHub package public, then rerun the failed release job.`);
  }
  const digest = response.headers.get("docker-content-digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) throw new Error("Registry returned an invalid image digest");
  const index = await response.json();
  const platforms = [...new Set((index.manifests ?? [])
    .filter((entry) => entry.platform?.os === "linux")
    .map((entry) => entry.platform.architecture))].sort();
  if (JSON.stringify(platforms) !== JSON.stringify(["amd64", "arm64"])) {
    throw new Error(`Image ${repository}:${version} must support linux/amd64 and linux/arm64`);
  }
  return { image: `ghcr.io/${repository}:${version}`, digest, platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.env.RELEASE_VERSION ?? "";
  const revision = process.env.RELEASE_SHA ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const output = process.argv[2];
  if (!output || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Release revision and output path are required");
  const images = {};
  for (const target of ["migration", "dashboard", "delivery"]) {
    images[target] = await verifyPublicImage(`${repository}-${target}`, version);
  }
  await writeFile(output, `${JSON.stringify({ version, revision, images }, null, 2)}\n`);
  console.log(`Verified public release images for ${version} on amd64 and arm64.`);
}
