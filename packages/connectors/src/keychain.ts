import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readSecretFromMacKeychain(
  service: string,
  account: string,
): Promise<string | null> {
  if (!service || !account) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      service,
      '-a',
      account,
      '-w',
    ]);
    const secret = stdout.trim();
    return secret.length > 0 ? secret : null;
  } catch {
    return null;
  }
}
