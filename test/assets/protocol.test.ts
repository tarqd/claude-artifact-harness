/**
 * The grammar and limits every side of `assets` shares (surface-area.md §5.4):
 * the accepted media types, the 20 MiB / 2 MiB-for-SVG caps, and the
 * `delete(idOrUrl)` reference forms.
 */
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_TYPES,
  ASSET_ERROR_CODES,
  MAX_BLOB_BYTES,
  MAX_SVG_BYTES,
  blobUrl,
  checkSize,
  checkType,
  isAcceptedType,
  isAssetErrorCode,
  limitFor,
  normalizeType,
  parseAssetRef,
} from "../../src/capabilities/assets/protocol.ts";

describe("the accepted type list", () => {
  it("is exactly what §5.4 documents", () => {
    expect(ACCEPTED_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "video/mp4",
      "video/webm",
      "application/pdf",
      "font/woff2",
      "font/woff",
      "font/ttf",
      "font/otf",
      "text/csv",
      "text/markdown",
      "application/json",
      "text/plain",
    ]);
  });

  it("refuses everything else", () => {
    for (const type of ["application/x-msdownload", "text/html", "image/x-icon", "application/wasm"]) {
      expect(isAcceptedType(type)).toBe(false);
    }
  });
});

describe("normalizeType", () => {
  it("strips parameters, trims and lower-cases", () => {
    expect(normalizeType("Text/CSV; charset=utf-8")).toBe("text/csv");
    expect(normalizeType("  image/PNG  ")).toBe("image/png");
  });

  it("is null for nothing usable", () => {
    expect(normalizeType("")).toBeNull();
    expect(normalizeType("   ")).toBeNull();
    expect(normalizeType(";charset=utf-8")).toBeNull();
    expect(normalizeType(undefined)).toBeNull();
    expect(normalizeType(7)).toBeNull();
  });
});

describe("checkType", () => {
  it("accepts a documented type", () => {
    expect(checkType("image/png; charset=binary")).toEqual({ type: "image/png" });
  });

  it("calls a missing type a caller bug and an unknown type unsupported", () => {
    const missing = checkType("");
    expect("error" in missing && missing.error.code).toBe("invalid_request");
    const unknown = checkType("application/x-msdownload");
    expect("error" in unknown && unknown.error.code).toBe("unsupported_type");
    expect("error" in unknown && unknown.error.message).toContain("application/x-msdownload");
  });
});

describe("the size caps", () => {
  it("is 20 MiB for a blob and 2 MiB for an SVG", () => {
    expect(MAX_BLOB_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_SVG_BYTES).toBe(2 * 1024 * 1024);
    expect(limitFor("image/png")).toBe(MAX_BLOB_BYTES);
    expect(limitFor("image/svg+xml")).toBe(MAX_SVG_BYTES);
  });

  it("passes the cap exactly and refuses one byte more", () => {
    expect(checkSize("image/png", MAX_BLOB_BYTES)).toBeNull();
    expect(checkSize("image/png", MAX_BLOB_BYTES + 1)?.code).toBe("too_large");
    expect(checkSize("image/svg+xml", MAX_SVG_BYTES)).toBeNull();
    const svg = checkSize("image/svg+xml", MAX_SVG_BYTES + 1);
    expect(svg?.code).toBe("too_large");
    expect(svg?.message).toContain("2 MiB");
    // An SVG under the SVG cap but over nothing else is still refused.
    expect(checkSize("image/svg+xml", 3 * 1024 * 1024)?.code).toBe("too_large");
    expect(checkSize("image/png", 3 * 1024 * 1024)).toBeNull();
  });
});

describe("parseAssetRef", () => {
  const id = "0123456789abcdef0123456789abcdef";

  it("accepts a 32-hex id and the /_blob/<id> url", () => {
    expect(parseAssetRef(id)).toBe(id);
    expect(parseAssetRef(`/_blob/${id}`)).toBe(id);
    expect(parseAssetRef(` /_blob/${id} `)).toBe(id);
    expect(parseAssetRef(`/_blob/${id}?v=2#x`)).toBe(id);
    expect(blobUrl(id)).toBe(`/_blob/${id}`);
  });

  it("refuses anything else, traversal included", () => {
    for (const ref of [
      "",
      "not-an-id",
      "/_blob/../secret",
      "/_blob/0123456789ABCDEF0123456789ABCDEF", // hex is lower case
      `/blob/${id}`,
      `https://elsewhere.test/_blob/${id}`,
      `${id}extra`,
      id.slice(0, 31),
      null,
      42,
    ]) {
      expect(parseAssetRef(ref)).toBeNull();
    }
  });
});

describe("the error codes", () => {
  it("names the four §5.4 documents and nothing else", () => {
    expect(ASSET_ERROR_CODES).toEqual([
      "invalid_request",
      "too_large",
      "unsupported_type",
      "upstream_error",
    ]);
    expect(isAssetErrorCode("too_large")).toBe(true);
    expect(isAssetErrorCode("not_writer")).toBe(false);
    expect(isAssetErrorCode(undefined)).toBe(false);
  });
});
