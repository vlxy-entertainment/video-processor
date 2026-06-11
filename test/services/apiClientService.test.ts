import { describe, it, expect, vi } from 'vitest';

// vi.hoisted ensures `instance` is available when the mock factory runs
// (factories are hoisted to the top of the file by Vitest/Babel, before
// any const declarations at module scope).
const instance = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  defaults: { headers: { common: {} as Record<string, string> } },
}));

vi.mock('axios', () => ({ default: { create: vi.fn(() => instance) } }));

import { ApiClientService } from '@/services/apiClientService';

describe('ApiClientService', () => {
  it('delegates verbs to the axios instance', () => {
    const c = new ApiClientService('http://api');
    c.get('u');
    c.post('u', {});
    c.put('u', {});
    c.delete('u');
    c.patch('u', {});
    expect(instance.get).toHaveBeenCalledWith('u', undefined);
    expect(instance.post).toHaveBeenCalled();
    expect(instance.put).toHaveBeenCalled();
    expect(instance.delete).toHaveBeenCalledWith('u', undefined);
    expect(instance.patch).toHaveBeenCalled();
  });

  it('sets headers and builds a cookie string', () => {
    const c = new ApiClientService('http://api');
    c.setHeader('Host', 'h');
    c.appendCookie({ a: '1', b: '2' });
    expect(instance.defaults.headers.common['Host']).toBe('h');
    expect(instance.defaults.headers.common['Cookie']).toBe('a=1; b=2');
  });

  it('appendCookie handles undefined values gracefully', () => {
    const c = new ApiClientService('http://api');
    c.appendCookie({ key: undefined, other: 'val' });
    expect(instance.defaults.headers.common['Cookie']).toBe('key=undefined; other=val');
  });

  it('passes config argument through to the axios instance', () => {
    const c = new ApiClientService('http://api');
    const cfg = { timeout: 5000 };
    c.get('u', cfg);
    expect(instance.get).toHaveBeenCalledWith('u', cfg);
    c.post('u', {}, cfg);
    expect(instance.post).toHaveBeenCalledWith('u', {}, cfg);
    c.put('u', {}, cfg);
    expect(instance.put).toHaveBeenCalledWith('u', {}, cfg);
    c.delete('u', cfg);
    expect(instance.delete).toHaveBeenCalledWith('u', cfg);
    c.patch('u', {}, cfg);
    expect(instance.patch).toHaveBeenCalledWith('u', {}, cfg);
  });
});
