import argon2 from 'argon2';

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try { return await argon2.verify(hash, password); } catch { return false; }
}

// verified against when the email is unknown, so a wrong email takes as long as a wrong password
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword('not-a-real-password-0'));
