// Each recording owns its phase. The legacy status field is a projection, never another state.
const PATHS = {
  gif: ['starting', 'pre-roll', 'recording', 'post-roll', 'completed'],
  har: ['starting', 'recording', 'draining', 'completed'],
  cdp: ['starting', 'recording', 'post-wait', 'completed'],
};

export function createRecordingLifecycle(kind, metadata = {}, persist = () => {}) {
  const path = PATHS[kind];
  if (!path) throw new Error(`Unknown recording kind: ${kind}`);
  let state = { ...metadata, phase: 'starting', status: 'starting' };
  persist({ ...state });

  return {
    get phase() { return state.phase; },
    snapshot() { return { ...state }; },
    transition(phase, details = {}) {
      const current = path.indexOf(state.phase);
      const terminal = state.phase === 'completed' || state.phase === 'failed';
      if (terminal || (phase !== 'failed' && path[current + 1] !== phase)) {
        throw new Error(`Invalid ${kind} recording transition: ${state.phase} -> ${phase}`);
      }
      const status = ['completed', 'failed'].includes(phase) ? phase
        : path.indexOf(phase) >= path.indexOf('recording') ? 'recording' : 'starting';
      const next = { ...state, ...details, phase, status };
      if (phase === 'recording') next.readyAt = new Date().toISOString();
      if (phase === 'completed' || phase === 'failed') next.completedAt = new Date().toISOString();
      persist({ ...next });
      state = next;
      return { ...state };
    },
  };
}
