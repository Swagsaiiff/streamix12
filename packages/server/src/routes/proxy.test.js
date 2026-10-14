import test from "node:test";
import assert from "node:assert/strict";
import {
  isPrivateOrLocalHost,
  isAllowedHost,
  validateProxyUrl,
  proxyMediaRequest
} from "./proxy.js";

test("isPrivateOrLocalHost identifies loopback and private IP addresses", () => {
  assert.equal(isPrivateOrLocalHost("localhost"), true);
  assert.equal(isPrivateOrLocalHost("127.0.0.1"), true);
  assert.equal(isPrivateOrLocalHost("127.1.2.3"), true);
  assert.equal(isPrivateOrLocalHost("10.0.0.1"), true);
  assert.equal(isPrivateOrLocalHost("192.168.1.1"), true);
  assert.equal(isPrivateOrLocalHost("172.16.0.1"), true);
  assert.equal(isPrivateOrLocalHost("172.31.255.255"), true);
  assert.equal(isPrivateOrLocalHost("169.254.169.254"), true); // AWS/cloud metadata
  assert.equal(isPrivateOrLocalHost("0.0.0.0"), true);
  assert.equal(isPrivateOrLocalHost("server.local"), true);
  assert.equal(isPrivateOrLocalHost("internal.lan"), true);
  assert.equal(isPrivateOrLocalHost("::1"), true);
  assert.equal(isPrivateOrLocalHost("[::1]"), true);
  assert.equal(isPrivateOrLocalHost("fe80::1"), true);

  // Valid public hostnames should not be flagged as private
  assert.equal(isPrivateOrLocalHost("pub-abc.r2.cloudflarestorage.com"), false);
  assert.equal(isPrivateOrLocalHost("pixeldrain.com"), false);
  assert.equal(isPrivateOrLocalHost("hubcloud.club"), false);
});

test("isAllowedHost permits only approved provider and CDN domains", () => {
  assert.equal(isAllowedHost("pub-123456.r2.cloudflarestorage.com"), true);
  assert.equal(isAllowedHost("media.r2.dev"), true);
  assert.equal(isAllowedHost("pixeldrain.com"), true);
  assert.equal(isAllowedHost("cdn.pixeldrain.com"), true);
  assert.equal(isAllowedHost("hubcloud.club"), true);
  assert.equal(isAllowedHost("vcloud.beer"), true);
  assert.equal(isAllowedHost("fastdl.ink"), true);
  assert.equal(isAllowedHost("nexdrive.beer"), true);
  assert.equal(isAllowedHost("gpdl1.online"), true);

  // Unapproved domains and attack vectors must be rejected
  assert.equal(isAllowedHost("evil.com"), false);
  assert.equal(isAllowedHost("google.com"), false);
  assert.equal(isAllowedHost("r2.cloudflarestorage.com.attacker.com"), false);
  assert.equal(isAllowedHost("pixeldrain.com.attacker.com"), false);
  assert.equal(isAllowedHost("127.0.0.1"), false);
  assert.equal(isAllowedHost("169.254.169.254"), false);
});

test("validateProxyUrl enforces protocol, private network protection, and domain restrictions", () => {
  // Missing parameter
  assert.equal(validateProxyUrl(null).valid, false);
  assert.equal(validateProxyUrl(null).status, 400);

  // Invalid protocol
  assert.equal(validateProxyUrl("file:///etc/passwd").valid, false);
  assert.equal(validateProxyUrl("ftp://r2.dev/video.mp4").valid, false);

  // SSRF attempts targeting internal services
  const localhostCheck = validateProxyUrl("http://localhost:4001/api/health");
  assert.equal(localhostCheck.valid, false);
  assert.equal(localhostCheck.status, 403);

  const metadataCheck = validateProxyUrl("http://169.254.169.254/latest/meta-data");
  assert.equal(metadataCheck.valid, false);
  assert.equal(metadataCheck.status, 403);

  // Unapproved external host
  const unapprovedCheck = validateProxyUrl("https://unapproved-site.com/movie.mkv");
  assert.equal(unapprovedCheck.valid, false);
  assert.equal(unapprovedCheck.status, 403);

  // Valid approved media URLs
  const r2Check = validateProxyUrl("https://pub-abc.r2.cloudflarestorage.com/hub2/movie.mkv?sig=123");
  assert.equal(r2Check.valid, true);
  assert.equal(r2Check.url.hostname, "pub-abc.r2.cloudflarestorage.com");

  const pixeldrainCheck = validateProxyUrl("https://pixeldrain.com/api/file/abc1234");
  assert.equal(pixeldrainCheck.valid, true);
});

test("proxyMediaRequest sets CORS headers and handles preflight OPTIONS", async () => {
  let statusSet = 0;
  const headers = {};
  const mockRes = {
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    status(code) {
      statusSet = code;
      return this;
    },
    end() {}
  };

  await proxyMediaRequest({ method: "OPTIONS", query: {}, headers: {} }, mockRes);
  assert.equal(headers["access-control-allow-origin"], "*");
  assert.equal(statusSet, 204);
});

test("proxyMediaRequest rejects forbidden hosts with 403 JSON", async () => {
  let statusSet = 0;
  let jsonSent = null;
  const headers = {};
  const mockRes = {
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    status(code) {
      statusSet = code;
      return this;
    },
    json(obj) {
      jsonSent = obj;
      return this;
    }
  };

  await proxyMediaRequest(
    {
      method: "GET",
      query: { url: "http://127.0.0.1:4001/admin" },
      headers: {},
      on() {}
    },
    mockRes
  );

  assert.equal(statusSet, 403);
  assert.equal(jsonSent.error, "proxy_error");
});
