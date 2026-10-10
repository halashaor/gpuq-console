export const SESSION_POLICY = {
  idleMs: 30 * 86400_000,
  touchMs: 3600_000,
  perAccount: 128,
  total: 100000,
};

export const LOGIN_POLICY = {failures: 5, windowMs: 60000, concurrent: 2};
