export type RateLimiterConfig = {
  [key: string]: any,
  RATELIMIT: {
    REVERSE_PROXIES?: number,
    MAX_LIMIT: number,
    WINDOW_SIZE: number,
    PATH?: string,
    SKIP_FAILED_REQUESTS?: boolean,
    [key: string]: any
  }
}