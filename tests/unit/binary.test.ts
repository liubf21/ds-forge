import { describe, expect, it } from "vitest";
import { isBinary } from "../../src/binary.js";

describe("isBinary", () => {
  it("treats plain UTF-8 text as non-binary", () => {
    expect(isBinary(Buffer.from("hello\nworld\n", "utf8"))).toBe(false);
  });

  it("treats an empty buffer as non-binary", () => {
    expect(isBinary(Buffer.alloc(0))).toBe(false);
  });

  it("flags a NUL byte in the prefix as binary", () => {
    expect(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x4e]))).toBe(true);
  });

  it("only scans the first 8KB — a NUL past the sample is missed", () => {
    const buf = Buffer.concat([Buffer.alloc(8192, 0x41), Buffer.from([0x00])]);
    expect(isBinary(buf)).toBe(false);
  });

  it("catches a NUL at the last byte of the sample window", () => {
    const buf = Buffer.alloc(8192, 0x41);
    buf[8191] = 0x00;
    expect(isBinary(buf)).toBe(true);
  });
});
