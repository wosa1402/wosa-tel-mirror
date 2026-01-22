import crypto from "node:crypto";
import { loadEnv } from "./env";

loadEnv();

function requireEncryptionSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET?.trim();
  if (!secret) throw new Error("Missing env ENCRYPTION_SECRET");
  return secret;
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  return crypto.scryptSync(secret, salt, 32);
}

export function decrypt(payload: string): string {
  if (!payload) return "";
  if (!payload.startsWith("v1:")) return payload;

  const parts = payload.split(":");
  if (parts.length !== 5) throw new Error("Invalid encrypted payload format");

  const [, saltB64, ivB64, ciphertextB64, tagB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const tag = Buffer.from(tagB64, "base64");

  const secret = requireEncryptionSecret();
  const key = deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

