// Pure JavaScript MD5 and HMAC-MD5 implementation for MovieBox request signing

const DEFAULT_SECRET_BYTES = new Uint8Array([
  0xef, 0xa8, 0x91, 0x97, 0x4e, 0xec, 0xd3, 0x14, 0x8d, 0xf6, 0x3a, 0xa6, 0x11, 0x60, 0x2d, 0xef,
  0xd1, 0x01, 0x25, 0x9b, 0xa5, 0x21, 0x02, 0x2c, 0x57, 0xae, 0x05, 0x66, 0xbd, 0x8e
]);

const SIGNATURE_BODY_MAX_BYTES = 102400;

function safeAdd(x, y) {
  const lsw = (x & 0xffff) + (y & 0xffff);
  const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  return (msw << 16) | (lsw & 0xffff);
}

function bitRotateLeft(num, cnt) {
  return (num << cnt) | (num >>> (32 - cnt));
}

function md5cmn(q, a, b, x, s, t) {
  return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
}

function md5ff(a, b, c, d, x, s, t) {
  return md5cmn((b & c) | (~b & d), a, b, x, s, t);
}

function md5gg(a, b, c, d, x, s, t) {
  return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function md5hh(a, b, c, d, x, s, t) {
  return md5cmn(b ^ c ^ d, a, b, x, s, t);
}

function md5ii(a, b, c, d, x, s, t) {
  return md5cmn(c ^ (b | ~d), a, b, x, s, t);
}

function binlMD5(x, len) {
  x[len >> 5] |= 0x80 << len % 32;
  x[(((len + 64) >>> 9) << 4) + 14] = len;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  for (let i = 0; i < x.length; i += 16) {
    const olda = a;
    const oldb = b;
    const oldc = c;
    const oldd = d;

    a = md5ff(a, b, c, d, x[i], 7, -680876936);
    d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = md5ff(c, d, a, b, x[i + 2], 17, 606105819);
    b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = md5ff(a, b, c, d, x[i + 4], 7, -176418897);
    d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341);
    b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416);
    d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = md5ff(c, d, a, b, x[i + 10], 17, -42063);
    b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682);
    d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290);
    b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);

    a = md5gg(a, b, c, d, x[i + 1], 5, -165796510);
    d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = md5gg(c, d, a, b, x[i + 11], 14, 643717713);
    b = md5gg(b, c, d, a, x[i], 20, -373897302);
    a = md5gg(a, b, c, d, x[i + 5], 5, -701558691);
    d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = md5gg(c, d, a, b, x[i + 15], 14, -660478335);
    b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = md5gg(a, b, c, d, x[i + 9], 5, 568446438);
    d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = md5gg(c, d, a, b, x[i + 3], 14, -187363961);
    b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467);
    d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473);
    b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);

    a = md5hh(a, b, c, d, x[i + 5], 4, -378558);
    d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562);
    b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060);
    d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = md5hh(c, d, a, b, x[i + 7], 16, -155497632);
    b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = md5hh(a, b, c, d, x[i + 13], 4, 681279174);
    d = md5hh(d, a, b, c, x[i], 11, -358537222);
    c = md5hh(c, d, a, b, x[i + 3], 16, -722521979);
    b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = md5hh(a, b, c, d, x[i + 9], 4, -640364487);
    d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = md5hh(c, d, a, b, x[i + 15], 16, 530742520);
    b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);

    a = md5ii(a, b, c, d, x[i], 6, -198630844);
    d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905);
    b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571);
    d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = md5ii(c, d, a, b, x[i + 10], 15, -1051523);
    b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359);
    d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380);
    b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = md5ii(a, b, c, d, x[i + 4], 6, -145523070);
    d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = md5ii(c, d, a, b, x[i + 2], 15, 718787259);
    b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);

    a = safeAdd(a, olda);
    b = safeAdd(b, oldb);
    c = safeAdd(c, oldc);
    d = safeAdd(d, oldd);
  }
  return [a, b, c, d];
}

function bytesToWords(bytes) {
  const words = [];
  for (let i = 0; i < bytes.length; i++) {
    words[i >> 2] |= (bytes[i] & 0xff) << ((i % 4) * 8);
  }
  return words;
}

function wordsToBytes(words) {
  const bytes = new Uint8Array(words.length * 4);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (words[i >> 2] >>> ((i % 4) * 8)) & 0xff;
  }
  return bytes;
}

function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i].toString(16);
    hex += b.length === 1 ? "0" + b : b;
  }
  return hex;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") return new TextEncoder().encode(input);
  return new Uint8Array(input);
}

export function md5(data) {
  const bytes = toUint8Array(data);
  const words = bytesToWords(bytes);
  const resultWords = binlMD5(words, bytes.length * 8);
  return wordsToBytes(resultWords);
}

export function md5Hex(data) {
  return bytesToHex(md5(data));
}

export function hmacMd5(keyBytes, data) {
  let key = toUint8Array(keyBytes);
  const dataBytes = toUint8Array(data);

  if (key.length > 64) {
    key = md5(key);
  }
  const paddedKey = new Uint8Array(64);
  paddedKey.set(key);

  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = paddedKey[i] ^ 0x36;
    opad[i] = paddedKey[i] ^ 0x5c;
  }

  const innerMsg = new Uint8Array(64 + dataBytes.length);
  innerMsg.set(ipad, 0);
  innerMsg.set(dataBytes, 64);
  const innerHash = md5(innerMsg);

  const outerMsg = new Uint8Array(64 + innerHash.length);
  outerMsg.set(opad, 0);
  outerMsg.set(innerHash, 64);
  return md5(outerMsg);
}

export function generateXClientToken(timestampMs) {
  const tsStr = String(timestampMs);
  const reversed = tsStr.split("").reverse().join("");
  const hash = md5Hex(reversed);
  return `${tsStr},${hash}`;
}

export function sortedQueryString(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const searchParams = new URLSearchParams(parsed.search);
    const keys = Array.from(new Set(searchParams.keys())).sort();
    const sortedPairs = [];
    for (const key of keys) {
      for (const val of searchParams.getAll(key)) {
        sortedPairs.push(`${key}=${val}`);
      }
    }
    return sortedPairs.join("&");
  } catch {
    return "";
  }
}

export function buildCanonicalString(method, accept, contentType, urlStr, body, timestampMs) {
  let canonicalUrl = urlStr;
  try {
    const parsed = new URL(urlStr);
    const path = parsed.pathname;
    const query = sortedQueryString(urlStr);
    canonicalUrl = query ? `${path}?${query}` : path;
  } catch {
    // fallback
  }

  let bodyLength = "";
  let bodyHash = "";
  if (body != null) {
    const bodyBytes = toUint8Array(body);
    bodyLength = String(bodyBytes.length);
    const truncated = bodyBytes.length > SIGNATURE_BODY_MAX_BYTES
      ? bodyBytes.subarray(0, SIGNATURE_BODY_MAX_BYTES)
      : bodyBytes;
    bodyHash = md5Hex(truncated);
  }

  return `${method.toUpperCase()}\n${accept || ""}\n${contentType || ""}\n${bodyLength}\n${timestampMs}\n${bodyHash}\n${canonicalUrl}`;
}

export function generateXTrSignature(method, accept, contentType, urlStr, body, timestampMs) {
  const canonical = buildCanonicalString(method, accept, contentType, urlStr, body, timestampMs);
  const hmacBytes = hmacMd5(DEFAULT_SECRET_BYTES, canonical);
  const sigB64 = bytesToBase64(hmacBytes);
  return `${timestampMs}|2|${sigB64}`;
}

export function randomHex(len) {
  let res = "";
  const chars = "0123456789abcdef";
  for (let i = 0; i < len; i++) {
    res += chars[Math.floor(Math.random() * chars.length)];
  }
  return res;
}

export function randomUuid() {
  return `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-a${randomHex(3)}-${randomHex(12)}`;
}

export function randomSpoofedIp() {
  const p1 = Math.floor(Math.random() * 150) + 50;
  const p2 = Math.floor(Math.random() * 254) + 1;
  const p3 = Math.floor(Math.random() * 254) + 1;
  const p4 = Math.floor(Math.random() * 254) + 1;
  return `${p1}.${p2}.${p3}.${p4}`;
}

export function generateClientInfoAndUA() {
  const androidVersions = [
    ["9", "PQ3A.190605.03081104"],
    ["10", "QP1A.191005.007.A3"],
    ["11", "RP1A.200720.011"],
    ["12", "S1B.220414.015"],
    ["13", "TQ2A.230405.003"]
  ];
  const redmiDevices = [
    ["23078RKD5C", "Redmi"],
    ["2201117TY", "Redmi"],
    ["2201117TG", "Redmi"],
    ["22101316G", "Redmi"],
    ["21121210G", "Redmi"],
    ["M2012K11AG", "Redmi"],
    ["M2007J20CG", "Redmi"]
  ];
  const versionCodes = [50020117, 50020118, 50020119, 50020120, 50020121];
  const networkTypes = ["NETWORK_WIFI", "NETWORK_MOBILE"];
  const timezones = [
    "Asia/Kolkata",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "America/New_York",
    "Europe/London"
  ];

  const android = androidVersions[Math.floor(Math.random() * androidVersions.length)];
  const device = redmiDevices[Math.floor(Math.random() * redmiDevices.length)];
  const versionCode = versionCodes[Math.floor(Math.random() * versionCodes.length)];
  const network = networkTypes[Math.floor(Math.random() * networkTypes.length)];
  const timezone = timezones[Math.floor(Math.random() * timezones.length)];
  const gaid = randomUuid();
  const deviceId = randomHex(32);

  const userAgent = `com.community.oneroom/${versionCode} (Linux; U; Android ${android[0]}; en_US; ${device[0]}; Build/${android[1]}; Cronet/135.0.7012.3)`;

  const clientInfo = JSON.stringify({
    package_name: "com.community.oneroom",
    version_name: "4.0.01.0813.03",
    version_code: versionCode,
    os: "android",
    os_version: android[0],
    install_ch: "ps",
    device_id: deviceId,
    install_store: "ps",
    gaid: gaid,
    brand: device[1],
    model: device[0],
    system_language: "en",
    net: network,
    region: "US",
    timezone: timezone,
    sp_code: "40401",
    "X-Play-Mode": "2"
  });

  return { userAgent, clientInfo, spoofedIp: randomSpoofedIp() };
}

export function buildSignedHeaders({
  method = "GET",
  url,
  body = null,
  authToken = null,
  userAgent,
  clientInfo,
  spoofedIp,
  timestampMs = Date.now()
}) {
  const accept = "application/json";
  const contentType = "application/json";

  const clientToken = generateXClientToken(timestampMs);
  const signature = generateXTrSignature(method, accept, contentType, url, body, timestampMs);

  const headers = {
    "User-Agent": userAgent,
    Accept: accept,
    "Content-Type": contentType,
    "x-client-token": clientToken,
    "x-tr-signature": signature,
    "x-client-info": clientInfo,
    "x-client-status": "0",
    "x-forwarded-for": spoofedIp
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  return headers;
}
