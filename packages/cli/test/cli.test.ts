import { describe, expect, it } from "vitest";
import { parseFlags } from "../src/cli.js";

describe("parseFlags", () => {
  it("parses --flag value pairs", () => {
    expect(parseFlags(["--source", "src_1", "--method", "POST"])).toEqual({
      source: "src_1",
      method: "POST",
    });
  });

  it("parses --flag=value form", () => {
    expect(parseFlags(["--source=src_1", "--api-base=http://x"])).toEqual({
      source: "src_1",
      "api-base": "http://x",
    });
  });

  it("treats a bare flag with no value as a string 'true'", () => {
    expect(parseFlags(["--keep-signature"])).toEqual({ "keep-signature": "true" });
  });

  it("ignores positional args (caller peels them before this layer)", () => {
    expect(parseFlags(["positional", "--source", "x"])).toEqual({ source: "x" });
  });
});
