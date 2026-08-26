import { describe, expect, it, vi } from "vitest";
import {
  assertResolvedHostSafe,
  ipMatchesAllowlist,
  isPrivateOrUnsafeIp,
  validateDestinationUrl,
} from "@axel/shared";

describe("assertResolvedHostSafe — DNS-rebinding guard", () => {
  it("passes a host that resolves to a public IP", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34" }]);
    expect(await assertResolvedHostSafe("example.com", lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledWith("example.com");
  });

  it("blocks a host that resolves to a private IP", async () => {
    const lookup = vi.fn(async () => [{ address: "10.0.0.5" }]);
    const reason = await assertResolvedHostSafe("rebind.evil.test", lookup);
    expect(reason).toMatch(/private\/link-local\/metadata IP \(10\.0\.0\.5\)/);
  });

  it("blocks a host that resolves to the cloud metadata IP", async () => {
    const lookup = vi.fn(async () => [{ address: "169.254.169.254" }]);
    expect(await assertResolvedHostSafe("metadata.evil.test", lookup)).toMatch(/169\.254\.169\.254/);
  });

  it("blocks when ANY resolved address is unsafe", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }]);
    expect(await assertResolvedHostSafe("mixed.test", lookup)).toMatch(/127\.0\.0\.1/);
  });

  it("blocks when resolution fails or returns nothing", async () => {
    expect(
      await assertResolvedHostSafe("nope.test", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toMatch(/could not be resolved/);
    expect(await assertResolvedHostSafe("empty.test", async () => [])).toMatch(/no addresses/);
  });

  it("short-circuits IP-literal hosts without resolving (already string-checked)", async () => {
    const lookup = vi.fn(async () => [{ address: "10.0.0.1" }]);
    expect(await assertResolvedHostSafe("93.184.216.34", lookup)).toBeNull();
    expect(await assertResolvedHostSafe("::1", lookup)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("validateDestinationUrl (AXE-34)", () => {
  it("accepts ordinary public https URLs", () => {
    expect(validateDestinationUrl("https://api.example.com/webhook")).toBeNull();
    expect(validateDestinationUrl("https://hooks.slack.com/services/foo/bar")).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(validateDestinationUrl("file:///etc/passwd")).toMatch(/http or https/i);
    expect(validateDestinationUrl("gopher://localhost/")).toMatch(/http or https/i);
  });

  it("rejects loopback and private IPs", () => {
    expect(validateDestinationUrl("http://127.0.0.1/")).toMatch(/private/i);
    expect(validateDestinationUrl("http://10.0.0.5:8080/")).toMatch(/private/i);
    expect(validateDestinationUrl("http://192.168.1.1/")).toMatch(/private/i);
    expect(validateDestinationUrl("http://172.16.0.1/")).toMatch(/private/i);
  });

  it("rejects cloud metadata endpoints", () => {
    expect(validateDestinationUrl("http://169.254.169.254/latest/meta-data/")).toMatch(/private/i);
    expect(validateDestinationUrl("http://metadata.google.internal/computeMetadata/v1/")).toMatch(/private/i);
  });

  it("rejects DNS-rebinding tricks like 127-0-0-1.nip.io", () => {
    expect(validateDestinationUrl("https://127-0-0-1.nip.io/")).toMatch(/loopback|private/i);
  });

  it("rejects bare localhost", () => {
    expect(validateDestinationUrl("http://localhost:8080/")).toMatch(/private/i);
  });

  it("can be relaxed for self-hosted private destinations", () => {
    expect(validateDestinationUrl("http://10.0.0.5/", { allowPrivate: true })).toBeNull();
  });

  it("can require https when toggled", () => {
    expect(validateDestinationUrl("http://api.example.com/", { requireHttps: true })).toMatch(/https/);
  });
});

describe("isPrivateOrUnsafeIp", () => {
  it("matches the IPv4 private/loopback ranges", () => {
    expect(isPrivateOrUnsafeIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrUnsafeIp("10.20.30.40")).toBe(true);
    expect(isPrivateOrUnsafeIp("8.8.8.8")).toBe(false);
  });

  it("matches IPv6 loopback and ULA", () => {
    expect(isPrivateOrUnsafeIp("::1")).toBe(true);
    expect(isPrivateOrUnsafeIp("fd00::1")).toBe(true);
    expect(isPrivateOrUnsafeIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("ipMatchesAllowlist (AXE-34)", () => {
  it("returns true when allowlist is empty (no allowlist configured)", () => {
    expect(ipMatchesAllowlist("8.8.8.8", [])).toBe(true);
  });

  it("matches exact /32 entries", () => {
    expect(ipMatchesAllowlist("3.18.12.63", ["3.18.12.63/32"])).toBe(true);
    expect(ipMatchesAllowlist("3.18.12.64", ["3.18.12.63/32"])).toBe(false);
  });

  it("matches bare-IP entries as /32", () => {
    expect(ipMatchesAllowlist("3.18.12.63", ["3.18.12.63"])).toBe(true);
  });

  it("matches multi-bit prefixes", () => {
    expect(ipMatchesAllowlist("13.107.6.152", ["13.107.6.152/31"])).toBe(true);
    expect(ipMatchesAllowlist("13.107.6.153", ["13.107.6.152/31"])).toBe(true);
    expect(ipMatchesAllowlist("13.107.6.154", ["13.107.6.152/31"])).toBe(false);
    expect(ipMatchesAllowlist("10.5.0.7", ["10.0.0.0/8"])).toBe(true);
    expect(ipMatchesAllowlist("11.5.0.7", ["10.0.0.0/8"])).toBe(false);
  });

  it("matches across multiple entries", () => {
    const list = ["3.0.0.0/8", "13.107.6.152/31"];
    expect(ipMatchesAllowlist("3.18.12.63", list)).toBe(true);
    expect(ipMatchesAllowlist("13.107.6.152", list)).toBe(true);
    expect(ipMatchesAllowlist("8.8.8.8", list)).toBe(false);
  });

  it("rejects malformed entries gracefully", () => {
    expect(ipMatchesAllowlist("8.8.8.8", ["not-an-ip"])).toBe(false);
    expect(ipMatchesAllowlist("8.8.8.8", ["8.8.8.8/64"])).toBe(false); // invalid bits
  });

  it("handles IPv6 exact-match entries", () => {
    expect(ipMatchesAllowlist("2001:db8::1", ["2001:db8::1"])).toBe(true);
    expect(ipMatchesAllowlist("2001:db8::2", ["2001:db8::1"])).toBe(false);
  });
});
