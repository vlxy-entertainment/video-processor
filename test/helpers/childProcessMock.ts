import { vi } from 'vitest';

/**
 * Builds a child_process mock whose execFile invokes its callback with the
 * configured stdout (Node's promisify expects (err, { stdout, stderr })).
 */
export function makeChildProcessMock(stdout = '', err: unknown = null) {
  const execFile = vi.fn(
    (_cmd: string, _args: string[], cb: (e: unknown, r: { stdout: string; stderr: string }) => void) => {
      cb(err, { stdout, stderr: '' });
    }
  );
  return { execFile };
}
