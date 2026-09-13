# Publishing a release

Only the maintainer merges release changes to `main`. The **Release** workflow
publishes images and creates a GitHub release from that reviewed commit. It does
not deploy Axel Cloud or push commits to `main`.

1. Update `VERSION` and the CLI package version together in a PR. Include the
   upgrade notes and get CI green before merging.
2. Run **Actions → Release → Run workflow** on `main`. Enter the matching version
   and the release notes. An existing release tag cannot be overwritten.
3. The workflow runs release verification, then builds the migration, dashboard,
   and delivery images for Linux x86-64 and ARM64. It attaches provenance and an
   SBOM, assembles the versioned manifests, and checks anonymous registry access.
4. On the first publication, open each package under the organization’s
   **Packages** tab and set its visibility to **Public**. GitHub creates container
   packages as private by default. If the anonymous check failed, rerun the failed
   job after changing visibility. Do not rerun the whole workflow after a release
   has been created.
5. Confirm the release contains `self-host-images.json`, and follow
   [self-hosting](self-hosting.md#use-a-published-release) from a clean checkout.

The GitHub release is created only after all three images can be read without
credentials and advertise both supported architectures. The attached manifest
records the source commit and each image’s immutable digest. Build tags include
the commit and workflow run ID; they are intermediate outputs, not upgrade targets.

If a build fails, rerun failed jobs. If a published version needs a correction,
use a new patch version. Back up the self-host database before testing upgrades;
rolling an image back does not reverse a database migration.
