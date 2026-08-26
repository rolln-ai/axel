import { describe, expect, it } from "vitest";
import { buildCliAuthLoginHint, quoteShellArgument } from "../lib/cli-command";

describe("self-host CLI login command", () => {
  it("pins login to the configured dashboard origin", () => {
    expect(buildCliAuthLoginHint("https://axel.example.test")).toContain(
      "axel auth login --api-base 'https://axel.example.test'",
    );
  });

  it("quotes operator-controlled URL bytes as one shell argument", () => {
    expect(quoteShellArgument("https://axel.example.test/it's-here")).toBe(
      `'https://axel.example.test/it'"'"'s-here'`,
    );
  });
});
