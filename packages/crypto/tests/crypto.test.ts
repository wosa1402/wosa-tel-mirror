import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src";

describe("@tg-back/crypto", () => {
  const originalSecret = process.env.ENCRYPTION_SECRET;

  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = "test-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = originalSecret;
  });

  it("encrypt/decrypt 能正常往返", () => {
    const payload = encrypt("hello");
    expect(payload.startsWith("v1:")).toBe(true);
    expect(decrypt(payload)).toBe("hello");
  });

  it("decrypt 对非 v1 载荷保持原样", () => {
    expect(decrypt("plain-text")).toBe("plain-text");
  });

  it("decrypt 空字符串返回空字符串", () => {
    expect(decrypt("")).toBe("");
  });
});

