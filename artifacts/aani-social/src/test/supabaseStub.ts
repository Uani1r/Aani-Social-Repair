// Test-only Supabase stub: the browser tests never reach a real project.
export const supabaseUrl = 'http://supabase.invalid';
export const supabaseConfigured = false;
export const storageBucket = 'media';

const unsupported = () => {
  throw new Error('Supabase is not available in profile reorder browser tests');
};

export const supabase = {
  auth: { getSession: unsupported, onAuthStateChange: unsupported },
  storage: { from: unsupported },
  channel: unsupported,
  removeChannel: unsupported,
  rpc: unsupported,
  from: unsupported,
};
