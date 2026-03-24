export interface AuthProfile {
  validatorIndex: number;
  validatorPubkey: string;
  passwordHash: string;
  salt: string;
  autoLockMinutes: number;
  createdAt: string;
}

const AUTH_PROFILE_KEY = 'beaconops_auth_profile_v1';
export const AUTH_PROFILE_CORRUPTED_ERROR = 'AUTH_PROFILE_CORRUPTED';
const PBKDF2_ITERATIONS = 160_000;
const PBKDF2_LENGTH_BITS = 256;
const MIN_AUTOLOCK_MINUTES = 1;
const MAX_AUTOLOCK_MINUTES = 240;

function storageSafe(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.trim();
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

function hexToBytes(value: string): Uint8Array {
  const normalized = normalizeHex(value);
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error(AUTH_PROFILE_CORRUPTED_ERROR);
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }

  return bytes;
}

function isValidBase64(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.length % 4 !== 0) {
    return false;
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return false;
  }

  try {
    base64ToBytes(normalized);
    return true;
  } catch {
    return false;
  }
}

function isValidHex(value: string): boolean {
  const normalized = normalizeHex(value);
  return Boolean(normalized) && normalized.length % 2 === 0 && /^[0-9a-f]+$/.test(normalized);
}

function decodeStoredBytes(value: string): Uint8Array {
  if (isValidHex(value)) {
    return hexToBytes(value);
  }

  if (isValidBase64(value)) {
    try {
      return base64ToBytes(value);
    } catch {
      throw new Error(AUTH_PROFILE_CORRUPTED_ERROR);
    }
  }

  throw new Error(AUTH_PROFILE_CORRUPTED_ERROR);
}

function encodeDerivedPassword(bytes: Uint8Array, storedHash: string): string {
  if (isValidHex(storedHash)) {
    return bytesToHex(bytes);
  }

  if (isValidBase64(storedHash)) {
    return bytesToBase64(bytes);
  }

  throw new Error(AUTH_PROFILE_CORRUPTED_ERROR);
}

async function derivePasswordBytes(password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (!window.crypto?.subtle) {
    throw new Error('WebCrypto API is unavailable in this runtime');
  }

  const encoder = new TextEncoder();
  const key = await window.crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const bits = await window.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    PBKDF2_LENGTH_BITS
  );

  return new Uint8Array(bits);
}

function parseProfile(raw: string | null): AuthProfile | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AuthProfile>;
    if (
      typeof parsed.validatorIndex !== 'number' ||
      !Number.isInteger(parsed.validatorIndex) ||
      parsed.validatorIndex < 0 ||
      typeof parsed.validatorPubkey !== 'string' ||
      typeof parsed.passwordHash !== 'string' ||
      typeof parsed.salt !== 'string' ||
      (!isValidHex(parsed.passwordHash) && !isValidBase64(parsed.passwordHash)) ||
      (!isValidHex(parsed.salt) && !isValidBase64(parsed.salt))
    ) {
      return null;
    }

    return {
      validatorIndex: parsed.validatorIndex,
      validatorPubkey: parsed.validatorPubkey,
      passwordHash: parsed.passwordHash,
      salt: parsed.salt,
      autoLockMinutes: normalizeAutoLockMinutes(parsed.autoLockMinutes),
      createdAt: parsed.createdAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function loadAuthProfile(): AuthProfile | null {
  const storage = storageSafe();
  if (!storage) {
    return null;
  }

  const raw = storage.getItem(AUTH_PROFILE_KEY);
  const parsed = parseProfile(raw);
  if (!parsed && raw) {
    storage.removeItem(AUTH_PROFILE_KEY);
  }
  return parsed;
}

export function saveAuthProfile(profile: AuthProfile): void {
  const storage = storageSafe();
  if (!storage) {
    return;
  }
  storage.setItem(AUTH_PROFILE_KEY, JSON.stringify(profile));
}

export function clearAuthProfile(): void {
  const storage = storageSafe();
  if (!storage) {
    return;
  }
  storage.removeItem(AUTH_PROFILE_KEY);
}

export function normalizeAutoLockMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 10;
  }

  return Math.min(
    MAX_AUTOLOCK_MINUTES,
    Math.max(MIN_AUTOLOCK_MINUTES, Math.round(value))
  );
}

export async function createPasswordSecret(
  password: string
): Promise<Pick<AuthProfile, 'passwordHash' | 'salt'>> {
  const saltBytes = new Uint8Array(16);
  window.crypto.getRandomValues(saltBytes);
  const derivedBytes = await derivePasswordBytes(password, saltBytes);
  const salt = bytesToHex(saltBytes);
  const passwordHash = bytesToHex(derivedBytes);
  return { passwordHash, salt };
}

export async function verifyPassword(
  password: string,
  profile: Pick<AuthProfile, 'passwordHash' | 'salt'>
): Promise<boolean> {
  const saltBytes = decodeStoredBytes(profile.salt);
  const derivedBytes = await derivePasswordBytes(password, saltBytes);
  const computed = encodeDerivedPassword(derivedBytes, profile.passwordHash);

  return computed === (isValidHex(profile.passwordHash) ? normalizeHex(profile.passwordHash) : profile.passwordHash.trim());
}

export function buildAuthProfile(input: {
  validatorIndex: number;
  validatorPubkey: string;
  passwordHash: string;
  salt: string;
  autoLockMinutes?: number;
}): AuthProfile {
  return {
    validatorIndex: input.validatorIndex,
    validatorPubkey: input.validatorPubkey,
    passwordHash: input.passwordHash,
    salt: input.salt,
    autoLockMinutes: normalizeAutoLockMinutes(input.autoLockMinutes ?? 10),
    createdAt: new Date().toISOString(),
  };
}
