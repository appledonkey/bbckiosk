const ITERATIONS = 100000;
const SALT_LEN = 16;
const HASH_LEN = 32;

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function deriveBits(pin, saltBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    HASH_LEN * 8
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const hashBytes = await deriveBits(pin, saltBytes);
  return { salt: bytesToHex(saltBytes), hash: bytesToHex(hashBytes) };
}

export async function verifyPin(pin, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const saltBytes = hexToBytes(salt);
    const hashBytes = await deriveBits(pin, saltBytes);
    return timingSafeEqual(bytesToHex(hashBytes), hash);
  } catch {
    return false;
  }
}
