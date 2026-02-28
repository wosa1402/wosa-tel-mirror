import { describe, expect, it } from "vitest";
import { parseSettingValue, parseSettingsRows } from "../src/settings-parse";

describe("parseSettingValue", () => {
  it("缺失/空值时返回默认值", () => {
    expect(parseSettingValue("default_mirror_mode", undefined)).toBe("forward");
    expect(parseSettingValue("concurrent_mirrors", undefined)).toBe(1);
    expect(parseSettingValue("message_filter_enabled", undefined)).toBe(false);
  });

  it("解析 default_mirror_mode（支持 trim/大小写）", () => {
    expect(parseSettingValue("default_mirror_mode", "copy")).toBe("copy");
    expect(parseSettingValue("default_mirror_mode", " COPY ")).toBe("copy");
    expect(parseSettingValue("default_mirror_mode", "invalid")).toBe("forward");
  });

  it("解析布尔值（支持 string/number）", () => {
    expect(parseSettingValue("message_filter_enabled", true)).toBe(true);
    expect(parseSettingValue("message_filter_enabled", "true")).toBe(true);
    expect(parseSettingValue("message_filter_enabled", "1")).toBe(true);
    expect(parseSettingValue("message_filter_enabled", 1)).toBe(true);

    expect(parseSettingValue("message_filter_enabled", false)).toBe(false);
    expect(parseSettingValue("message_filter_enabled", "false")).toBe(false);
    expect(parseSettingValue("message_filter_enabled", "0")).toBe(false);
    expect(parseSettingValue("message_filter_enabled", 0)).toBe(false);
  });

  it("解析数字（支持数字字符串）", () => {
    expect(parseSettingValue("concurrent_mirrors", 3)).toBe(3);
    expect(parseSettingValue("concurrent_mirrors", "3")).toBe(3);
    expect(parseSettingValue("concurrent_mirrors", "  ")).toBe(1);
    expect(parseSettingValue("concurrent_mirrors", "NaN")).toBe(1);
  });
});

describe("parseSettingsRows", () => {
  it("缺失的 key 会被默认值补齐", () => {
    const settings = parseSettingsRows([
      { key: "default_mirror_mode", value: "copy" },
      { key: "concurrent_mirrors", value: "5" },
    ]);

    expect(settings.default_mirror_mode).toBe("copy");
    expect(settings.concurrent_mirrors).toBe(5);
    expect(settings.message_filter_enabled).toBe(false);
  });
});

