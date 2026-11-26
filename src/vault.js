// Credential vault: AES-256-GCM with a master key from the MASTER_KEY env var
// (64 hex chars, generate with: openssl rand -hex 32).
// Each record gets a random IV. Output format: base64(iv).base64(tag).base64(ciphertext).
// The master key never lives in the database or in code, only in the server environment.
import crypto from 'node:crypto';

function masterKey() {
    const hex = process.env.MASTER_KEY;
    if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
        throw new Error('MASTER_KEY env var missing or invalid. Generate one with: openssl rand -hex 32');
    }
    return Buffer.from(hex, 'hex');
}

export function encryptSecret(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decryptSecret(payload) {
    const [iv, tag, ct] = String(payload).split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
    try {
        const [, salt, hash] = String(stored).split(':');
        const candidate = crypto.scryptSync(String(password), salt, 64);
        return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
    } catch { return false; }
}

export function randomToken() {
    return crypto.randomBytes(32).toString('base64url');
}
