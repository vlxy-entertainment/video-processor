import { describe, it, expect } from 'vitest';
import { makeSupabaseMock } from './supabaseMock';

describe('supabaseMock', () => {
  it('chains and resolves the scripted result via single()', async () => {
    const { supabase } = makeSupabaseMock([{ data: { id: 'x' }, error: null }]);
    const res = await supabase.from('t').select('*').eq('id', 'x').single();
    expect(res).toEqual({ data: { id: 'x' }, error: null });
  });

  it('is awaitable without single()', async () => {
    const { supabase } = makeSupabaseMock([{ data: [1, 2], error: null }]);
    const res = await supabase.from('t').select('*').order('index');
    expect(res).toEqual({ data: [1, 2], error: null });
  });

  it('consumes multiple results in order', async () => {
    const { supabase } = makeSupabaseMock([
      { data: [{ id: 'p' }], error: null },
      { data: { id: 'claimed' }, error: null },
    ]);
    const a = await supabase.from('t').select('id').eq('status', 'processing').limit(1);
    const b = await supabase.from('t').update({}).eq('id', 'p').select().single();
    expect(a.data).toEqual([{ id: 'p' }]);
    expect(b.data).toEqual({ id: 'claimed' });
  });
});
