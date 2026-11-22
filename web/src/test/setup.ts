import '@testing-library/jest-dom/vitest';

// Polyfill EventSource for tests
if (typeof globalThis.EventSource === 'undefined') {
  class MockEventSource {
    url: string;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(url: string) {
      this.url = url;
    }
    close() {}
  }
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
}

// Polyfill WebSocket for tests
if (typeof globalThis.WebSocket === 'undefined') {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    send() {}
    close() {}
  }
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
}
