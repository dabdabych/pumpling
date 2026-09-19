import { Buffer as BufferType } from 'buffer';

declare global {
  interface Window {
    Buffer: typeof BufferType;
    global: typeof globalThis;
    process: {
      env: { DEBUG: undefined };
      version: string;
      nextTick: (fn: Function, ...args: any[]) => void;
    };
    solana?: any;
  }
}

export {};
