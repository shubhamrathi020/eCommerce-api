import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/** OWASP-recommended Argon2id settings (19 MiB memory, 2 iterations, 1 lane). */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  /** Precomputed so a login for an unknown email costs the same as a real one (no timing leak). */
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  async verify(hash: string | undefined, password: string): Promise<boolean> {
    this.dummyHash ??= argon2.hash('dummy-password-for-timing', OPTIONS);
    try {
      return await argon2.verify(hash ?? (await this.dummyHash), password);
    } catch {
      return false;
    }
  }
}
