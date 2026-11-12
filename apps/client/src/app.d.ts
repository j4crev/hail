declare global {
  namespace App {
    interface Error {
      message: string;
      /** Seconds until a temporarily unavailable mailbox read may be retried. */
      retryAfter?: number;
    }
  }
}

export {};
