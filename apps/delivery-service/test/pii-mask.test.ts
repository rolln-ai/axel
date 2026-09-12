import { describe, expect, it } from "vitest";
import {
  controlPlaneDbSslVerify,
  controlPlanePgSslOption,
  maskPiiInText,
} from "@axel/shared";

describe("maskPiiInText", () => {
  it("masks email addresses", () => {
    expect(maskPiiInText("contact alice@example.com now")).toBe("contact [EMAIL] now");
  });
  it("masks long digit runs (cards/accounts/SSNs), grouped or not", () => {
    expect(maskPiiInText("card 4111111111111111")).toBe("card [NUM]");
    expect(maskPiiInText("card 4111 1111 1111 1111")).toBe("card [NUM]");
    expect(maskPiiInText("ssn 123-45-6789")).toBe("ssn [NUM]");
  });
  it("keeps short numbers and identifiers", () => {
    expect(maskPiiInText("status 404 on route rt_12")).toBe("status 404 on route rt_12");
  });
});

describe("controlPlaneDbSslVerify", () => {
  it("verifies only when the flag is exactly 'true'", () => {
    expect(controlPlaneDbSslVerify("true")).toBe(true);
    expect(controlPlaneDbSslVerify("false")).toBe(false);
    expect(controlPlaneDbSslVerify("1")).toBe(false);
    expect(controlPlaneDbSslVerify(undefined)).toBe(false);
  });
});

describe("controlPlanePgSslOption", () => {
  it("honors an explicit local sslmode=disable", () => {
    expect(controlPlanePgSslOption("postgres://axel@postgres:5432/axel?sslmode=disable", undefined)).toBe(false);
  });

  it("verifies remote control-plane certificates when enabled", () => {
    expect(controlPlanePgSslOption("postgres://axel@db.example/axel", "true")).toEqual({
      rejectUnauthorized: true,
    });
  });
});
